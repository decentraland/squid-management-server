import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListServicesCommand,
  ListServicesRequest,
  ListTasksCommand,
  UpdateServiceCommand
} from '@aws-sdk/client-ecs'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@dcl/pg-component'
import { Network } from '@dcl/schemas'
import {
  getActiveSchemaByProjectQuery,
  getActiveSchemaQuery,
  getLatestSlotServicesQuery,
  getPromoteQuery,
  getSchemaByServiceNameQuery
} from './queries'
import { ISquidComponent, IsLiveResult, Squid, SquidMetric, SquidServiceTopology } from './types'
import { computeSyncProgress, getMetricValue, getProjectNameFromService, getSquidsNetworksMapping } from './utils'

const AWS_REGION = 'us-east-1'
const DEFAULT_TOPOLOGY_CACHE_TTL_MS = 30 * 1000

export async function createSubsquidComponent({
  fetch,
  dappsDatabase,
  creditsDatabase,
  config,
  logs
}: {
  fetch: IFetchComponent
  dappsDatabase: IPgComponent
  creditsDatabase: IPgComponent
  config: IConfigComponent
  logs: ILoggerComponent
}): Promise<ISquidComponent> {
  const logger = logs.getLogger('squids-component')
  const cluster = await config.requireString('AWS_CLUSTER_NAME')
  const client = new ECSClient({ region: AWS_REGION })

  // Topology (ECS + schema info) changes rarely, so it is cached to keep frequent
  // polling cheap. The live processor metrics are always scraped fresh on top of it.
  const topologyCacheTtl = (await config.getNumber('SQUID_TOPOLOGY_CACHE_TTL_MS')) ?? DEFAULT_TOPOLOGY_CACHE_TTL_MS
  let cachedTopology: SquidServiceTopology[] | null = null
  let topologyExpiresAt = 0
  let inFlightTopology: Promise<SquidServiceTopology[]> | null = null
  // Bumped on every invalidation so an in-flight discovery started before the
  // invalidation cannot write its (now stale) result back into the cache.
  let topologyGeneration = 0

  function getDatabaseFromServiceName(serviceName: string): IPgComponent {
    if (serviceName.includes('credits-squid-server')) {
      return creditsDatabase
    }
    return dappsDatabase
  }

  /**
   * Discovers the squid topology from ECS and the indexers/squids tables. This is
   * the expensive part (several ECS API calls per service) and excludes the live
   * processor metrics, which are scraped separately.
   *
   * Flow:
   * 1. List all services in the cluster and keep the squid ones.
   * 2. Describe those services to get their tasks.
   * 3. For each service, resolve its writing schema and the project's active schema,
   *    and read task details (version, status, image, private IP).
   */
  async function discoverTopology(): Promise<SquidServiceTopology[]> {
    // Step 1: List all services
    const input: ListServicesRequest = {
      cluster,
      maxResults: 100
    }
    const listServicesCommand = new ListServicesCommand(input)
    const servicesResponse = await client.send(listServicesCommand)

    const serviceArns = servicesResponse.serviceArns || []
    const squidServices = serviceArns.filter(arn => arn.includes('-squid-server'))

    // Step 2: Describe services in parallel
    const describeServicesCommand = new DescribeServicesCommand({
      cluster,
      services: squidServices
    })

    const describeServicesResponse = await client.send(describeServicesCommand)
    const services = describeServicesResponse.services || []

    // Process all services in parallel
    return Promise.all(
      services.map(async squidService => {
        const serviceName = squidService.serviceName || ''
        const listTasksCommand = new ListTasksCommand({
          cluster,
          serviceName
        })
        const taskResponse = await client.send(listTasksCommand)
        const taskArns = taskResponse.taskArns || []

        const database = getDatabaseFromServiceName(serviceName)
        const schemaName = (await database.query(getSchemaByServiceNameQuery(serviceName))).rows[0]?.schema
        const projectActiveSchema = (await database.query(getActiveSchemaQuery(serviceName))).rows[0]?.schema

        const topology: SquidServiceTopology = {
          service_name: serviceName,
          schema_name: schemaName,
          project_active_schema: projectActiveSchema,
          version: 0,
          networks: getSquidsNetworksMapping(serviceName)
        }

        if (taskArns.length === 0) {
          return topology
        }

        // Step 3: Describe tasks to get container information
        const describeTasksCommand = new DescribeTasksCommand({
          cluster,
          tasks: taskArns
        })
        const describeResponse = await client.send(describeTasksCommand)
        const tasks = describeResponse.tasks || []

        // there should be just one task per service
        for (const task of tasks) {
          topology.version = task.version || 0
          topology.created_at = task.createdAt
          topology.health_status = task.healthStatus
          topology.service_status = task.lastStatus

          // Extract image URI from the task definition containers
          // Look for the main container (usually the first one or the one with squid in the name)
          const mainContainer = task.containers?.find(container => container.name?.includes('squid')) || task.containers?.[0]

          if (mainContainer?.image) {
            topology.image_uri = mainContainer.image
          }

          const ElasticNetworkInterface = 'ElasticNetworkInterface'
          const privateIPv4Address = 'privateIPv4Address'

          const ip = task.attachments
            ?.find(att => att.type === ElasticNetworkInterface)
            ?.details?.find(detail => detail.name === privateIPv4Address)?.value

          if (ip) {
            topology.ip = ip
          }
        }

        return topology
      })
    )
  }

  /**
   * Returns the squid topology, served from an in-memory cache with a TTL so that
   * frequent polling does not hammer the ECS API. Concurrent calls during a cache
   * miss share a single discovery (single-flight). On a discovery error the stale
   * cache is served when available and the expiry is not extended, so the next call
   * retries.
   */
  async function getTopology(): Promise<SquidServiceTopology[]> {
    const now = Date.now()
    if (cachedTopology && now < topologyExpiresAt) {
      return cachedTopology
    }

    if (!inFlightTopology) {
      const generation = topologyGeneration
      inFlightTopology = discoverTopology()
        .then(topology => {
          // Only write back if no invalidation happened while we were discovering,
          // otherwise we would resurrect a stale topology with a fresh TTL.
          if (generation === topologyGeneration) {
            cachedTopology = topology
            topologyExpiresAt = Date.now() + topologyCacheTtl
          }
          return topology
        })
        .catch(error => {
          logger.error('Error discovering squid topology:', { error: String(error) })
          return cachedTopology ?? []
        })
        .finally(() => {
          if (generation === topologyGeneration) {
            inFlightTopology = null
          }
        })
    }

    return inFlightTopology
  }

  // Forces the next list() to re-discover the topology. Called after operations
  // that change it (promote/downgrade) so the UI reflects them immediately. Bumping
  // the generation also discards any discovery currently in flight.
  function invalidateTopologyCache(): void {
    cachedTopology = null
    topologyExpiresAt = 0
    topologyGeneration++
    inFlightTopology = null
  }

  /**
   * Scrapes the live processor metrics for every network of a squid service and
   * enriches each one with the derived sync progress. Returns an empty record when
   * the service has no known IP (e.g. it is stopped).
   */
  async function scrapeMetrics(topology: SquidServiceTopology): Promise<Record<Network.ETHEREUM | Network.MATIC, SquidMetric>> {
    const metrics = {} as Record<Network.ETHEREUM | Network.MATIC, SquidMetric>
    if (!topology.ip) {
      return metrics
    }

    const metricsResults = await Promise.allSettled(
      topology.networks.map(async network => {
        const response = await fetch.fetch(`http://${topology.ip}:${network.port}/metrics`)
        const text = await response.text()
        const lastBlock = getMetricValue(text, 'sqd_processor_last_block')
        const chainHeight = getMetricValue(text, 'sqd_processor_chain_height')

        return {
          networkName: network.name,
          metrics: {
            sqd_processor_sync_eta_seconds: getMetricValue(text, 'sqd_processor_sync_eta_seconds'),
            sqd_processor_mapping_blocks_per_second: getMetricValue(text, 'sqd_processor_mapping_blocks_per_second'),
            sqd_processor_last_block: lastBlock,
            sqd_processor_chain_height: chainHeight,
            progress: computeSyncProgress(lastBlock, chainHeight)
          }
        }
      })
    )

    metricsResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        metrics[result.value.networkName] = result.value.metrics
      } else {
        logger.error(`Failed to fetch metrics for network ${topology.networks[index].name}:`, result.reason)
      }
    })

    return metrics
  }

  async function list(): Promise<Squid[]> {
    try {
      const topology = await getTopology()

      // Scrape the live metrics for every service on top of the cached topology.
      const results = await Promise.all(
        topology.map(async service => {
          const metrics = await scrapeMetrics(service)

          const squid: Partial<Squid> = {
            name: service.service_name,
            service_name: service.service_name,
            schema_name: service.schema_name,
            project_active_schema: service.project_active_schema,
            version: service.version,
            created_at: service.created_at,
            health_status: service.health_status,
            service_status: service.service_status,
            image_uri: service.image_uri,
            metrics
          }

          // Only include complete squid objects
          if (squid.created_at && squid.health_status && squid.service_status) {
            return squid as Squid
          } else {
            logger.warn(`Skipping incomplete squid: ${squid.service_name}`)
            return null
          }
        })
      )

      // Filter out null values
      return results.filter((squid): squid is Squid => squid !== null)
    } catch (error) {
      logger.error('Error listing services:', { error: String(error) })
      return []
    }
  }

  async function downgrade(serviceName: string): Promise<void> {
    try {
      const updateServiceCommand = new UpdateServiceCommand({
        cluster,
        service: serviceName,
        desiredCount: 0
      })
      await client.send(updateServiceCommand)
      invalidateTopologyCache()
      logger.info(`Service ${serviceName} stopped!`)
    } catch (error) {
      logger.error('Error stopping service:', { error: String(error), service: serviceName })
    }
  }

  async function promote(serviceName: string): Promise<void> {
    const projectName = getProjectNameFromService(serviceName) // e.g: service name is marketplace-squid-server-a-blue-92e812a, project is marketplace
    const schemaName = `squid_${projectName}` // e.g: squid_marketplace
    const promoteQuery = getPromoteQuery(serviceName, schemaName, projectName)

    const database = getDatabaseFromServiceName(serviceName)
    await database.query(promoteQuery)

    // The promotion changes the active schema, so drop the cached topology to surface it immediately.
    invalidateTopologyCache()

    logger.info(`The ${serviceName} was promoted and the active schema is ${schemaName}`)

    // Call marketplace server to recreate triggers and refresh materialized view for marketplace or trades squids
    if (serviceName.includes('marketplace-squid-server') || serviceName.includes('trades-squid-server')) {
      try {
        const marketplaceServerUrl = await config.getString('MARKETPLACE_API_URL')
        if (!marketplaceServerUrl) {
          console.warn('MARKETPLACE_API_URL not configured, skipping materialized view recreation')
          return
        }

        const apiToken = await config.getString('MARKETPLACE_SERVER_TRADES_API_TOKEN')
        if (!apiToken) {
          console.warn('MARKETPLACE_SERVER_TRADES_API_TOKEN not configured, skipping materialized view recreation')
          return
        }

        const response = await fetch.fetch(`${marketplaceServerUrl}/trades/materialized-view/recreate`, {
          method: 'POST',
          headers: {
            'x-api-token': apiToken
          }
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.error(`Failed to recreate materialized view: ${response.status} ${errorText}`)
        } else {
          console.log('Successfully recreated materialized view and triggers')
        }
      } catch (error) {
        console.error('Error calling marketplace server to recreate materialized view:', error)
        // We don't throw here to avoid failing the promotion if the marketplace server call fails
      }
    }
  }

  /**
   * Returns whether the given (project, slot) is currently serving as the LIVE
   * indexer. A slot can have several ECS services running side-by-side during
   * blue/green transitions (e.g., `marketplace-squid-server-a-blue-92e812a` and
   * `marketplace-squid-server-a-green-abc1234` may coexist). The slot is LIVE if
   * any of its services has its latest indexers.schema matching the project's
   * promoted schema in the squids table.
   *
   * Returns live=false (safe default) if the project has no entry in `squids`
   * or no service in the slot has an indexers row.
   *
   * `project` and `slot` are validated against a safe alphanumeric+hyphen charset
   * upstream by the handler, since `slot` is interpolated into a LIKE pattern.
   */
  async function isLive(project: string, slot: string): Promise<IsLiveResult> {
    const database = project === 'credits' ? creditsDatabase : dappsDatabase
    const [activeRes, slotRes] = await Promise.all([
      database.query<{ schema: string }>(getActiveSchemaByProjectQuery(project)),
      database.query<{ service: string; schema: string }>(getLatestSlotServicesQuery(project, slot))
    ])
    const activeSchema = activeRes.rows[0]?.schema ?? null
    const services = slotRes.rows
    const liveService = activeSchema ? (services.find(s => s.schema === activeSchema)?.service ?? null) : null
    return {
      live: liveService !== null,
      activeSchema,
      liveService,
      services
    }
  }

  return {
    list,
    promote,
    downgrade,
    isLive
  }
}
