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
import { PoolClient } from 'pg'
import { IPgComponent } from '@dcl/pg-component'
import { Network } from '@dcl/schemas'
import {
  buildDropSchemaStatement,
  getActiveSchemaQuery,
  getActivelyPromotedSchemasQuery,
  getDeleteIndexersBySchemaQuery,
  getPromoteQuery,
  getSchemaAgesQuery,
  getSchemaByServiceNameQuery,
  getSquidSchemasQuery
} from './queries'
import { DatabaseName, ISquidComponent, PurgeOptions, PurgeResult, PurgeSkipReason, Squid, SquidMetric } from './types'
import { getMetricValue, getProjectNameFromService, getSquidsNetworksMapping } from './utils'

const AWS_REGION = 'us-east-1'

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

  function getDatabaseFromServiceName(serviceName: string): IPgComponent {
    if (serviceName.includes('credits-squid-server')) {
      return creditsDatabase
    }
    return dappsDatabase
  }

  async function list(): Promise<Squid[]> {
    try {
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
      const results = await Promise.all(
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

          const squid: Partial<Squid> = {
            name: serviceName,
            service_name: serviceName,
            schema_name: schemaName,
            project_active_schema: projectActiveSchema,
            metrics: {} as Record<Network.ETHEREUM | Network.MATIC, SquidMetric>
          }

          if (taskArns.length === 0) {
            return squid
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
            squid.version = task.version || 0
            squid.created_at = task.createdAt
            squid.health_status = task.healthStatus
            squid.service_status = task.lastStatus

            // Extract image URI from the task definition containers
            // Look for the main container (usually the first one or the one with squid in the name)
            const mainContainer = task.containers?.find(container => container.name?.includes('squid')) || task.containers?.[0]

            if (mainContainer?.image) {
              squid.image_uri = mainContainer.image
            }

            const ElasticNetworkInterface = 'ElasticNetworkInterface'
            const privateIPv4Address = 'privateIPv4Address'

            const ip = task.attachments
              ?.find(att => att.type === ElasticNetworkInterface)
              ?.details?.find(detail => detail.name === privateIPv4Address)?.value

            if (!ip) continue

            // Fetch metrics for each network in parallel
            try {
              const metricsResults = await Promise.allSettled(
                getSquidsNetworksMapping(serviceName).map(async network => {
                  const response = await fetch.fetch(`http://${ip}:${network.port}/metrics`)
                  const text = await response.text()

                  return {
                    networkName: network.name,
                    metrics: {
                      sqd_processor_sync_eta_seconds: getMetricValue(text, 'sqd_processor_sync_eta_seconds'),
                      sqd_processor_mapping_blocks_per_second: getMetricValue(text, 'sqd_processor_mapping_blocks_per_second'),
                      sqd_processor_last_block: getMetricValue(text, 'sqd_processor_last_block'),
                      sqd_processor_chain_height: getMetricValue(text, 'sqd_processor_chain_height')
                    }
                  }
                })
              )

              // Process successful metric fetches
              metricsResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                  const { networkName, metrics } = result.value
                  if (!squid.metrics) {
                    squid.metrics = {
                      [Network.ETHEREUM]: {} as SquidMetric,
                      [Network.MATIC]: {} as SquidMetric
                    }
                  }
                  squid.metrics[networkName] = metrics
                } else {
                  logger.error(`Failed to fetch metrics for network ${getSquidsNetworksMapping(serviceName)[index].name}:`, result.reason)
                }
              })
            } catch (error) {
              logger.error(`Failed to fetch metrics for ${ip}:`, { error: String(error) })
            }
          }

          // Only include complete squid objects
          if (squid.created_at && squid.health_status && squid.service_status) {
            return squid
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

  // Schema names we create always match this shape; gate every DROP behind the same pattern.
  const SAFE_SCHEMA_NAME = /^squid_[a-zA-Z0-9_]+$/

  async function purgeSchemasInDatabase(
    databaseName: DatabaseName,
    database: IPgComponent,
    runningServiceNames: string[],
    olderThanMs: number,
    dryRun: boolean
  ): Promise<PurgeResult> {
    const deleted: PurgeResult['deleted'] = []
    const skipped: PurgeResult['skipped'] = []

    const { rows: existing } = await database.query<{ schema_name: string }>(getSquidSchemasQuery())
    if (existing.length === 0) return { deleted, skipped }

    const schemaNames = existing.map(row => row.schema_name)
    const { rows: ageRows } = await database.query<{ schema: string; max_created_at: Date }>(getSchemaAgesQuery(schemaNames))
    const schemaAges = new Map(ageRows.map(row => [row.schema, new Date(row.max_created_at).getTime()]))

    const { rows: activeRows } = await database.query<{ schema: string }>(getActivelyPromotedSchemasQuery())
    const activeSchemas = new Set(activeRows.filter(row => row.schema).map(row => row.schema))

    const runningServiceSchemas = new Set<string>()
    for (const serviceName of runningServiceNames) {
      const { rows } = await database.query<{ schema: string }>(getSchemaByServiceNameQuery(serviceName))
      const latest = rows[0]?.schema
      if (latest) runningServiceSchemas.add(latest)
    }

    const now = Date.now()
    for (const schema of schemaNames) {
      const createdAt = schemaAges.get(schema)
      if (createdAt === undefined) {
        // We didn't create it (no indexers row) — leave it alone entirely, don't even report.
        continue
      }
      const ageMs = now - createdAt
      if (ageMs < olderThanMs) continue

      const entry = { database: databaseName, schema, ageMs }
      const reason: PurgeSkipReason | undefined = activeSchemas.has(schema)
        ? 'active'
        : runningServiceSchemas.has(schema)
          ? 'running-service'
          : !SAFE_SCHEMA_NAME.test(schema)
            ? 'invalid-name'
            : undefined

      if (reason) {
        skipped.push({ ...entry, reason })
        continue
      }

      if (!dryRun) {
        await database.withTransaction(async (pgClient: PoolClient) => {
          await pgClient.query(buildDropSchemaStatement(schema))
          await pgClient.query(getDeleteIndexersBySchemaQuery(schema))
        })
      }
      deleted.push(entry)
    }

    return { deleted, skipped }
  }

  // Minimal ECS query used by the purge: we only need the names of services that currently have a task.
  // list() does the same plus describes tasks + fetches metrics, which is too heavy here.
  async function getRunningSquidServiceNames(): Promise<string[]> {
    const { serviceArns = [] } = await client.send(new ListServicesCommand({ cluster, maxResults: 100 }))
    const squidArns = serviceArns.filter(arn => arn.includes('-squid-server'))
    if (squidArns.length === 0) return []

    const { services = [] } = await client.send(new DescribeServicesCommand({ cluster, services: squidArns }))

    const running: string[] = []
    await Promise.all(
      services.map(async svc => {
        const serviceName = svc.serviceName
        if (!serviceName) return
        const { taskArns = [] } = await client.send(new ListTasksCommand({ cluster, serviceName }))
        if (taskArns.length > 0) running.push(serviceName)
      })
    )
    return running
  }

  async function purgeOldSchemas({ olderThanMs, dryRun = false }: PurgeOptions): Promise<PurgeResult> {
    if (olderThanMs <= 0) {
      throw new Error(`purgeOldSchemas: olderThanMs must be positive (received ${olderThanMs})`)
    }

    // Safety rail: if we can't determine what is running, don't delete anything.
    // An empty ECS response or a transient error must not be interpreted as "nothing is running".
    let runningServiceNames: string[]
    try {
      runningServiceNames = await getRunningSquidServiceNames()
    } catch (error) {
      logger.warn('purgeOldSchemas: could not list running services — aborting as a safety measure', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { deleted: [], skipped: [] }
    }
    if (runningServiceNames.length === 0) {
      logger.warn('purgeOldSchemas: no running squid services detected — aborting as a safety measure')
      return { deleted: [], skipped: [] }
    }

    const result: PurgeResult = { deleted: [], skipped: [] }

    for (const [name, database] of [
      ['dapps', dappsDatabase],
      ['credits', creditsDatabase]
    ] as const) {
      try {
        const partial = await purgeSchemasInDatabase(name, database, runningServiceNames, olderThanMs, dryRun)
        result.deleted.push(...partial.deleted)
        result.skipped.push(...partial.skipped)
      } catch (error) {
        logger.error(`purgeOldSchemas: failed while processing ${name} database`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    logger.info(
      `purgeOldSchemas ${dryRun ? '(dry-run) would delete' : 'deleted'} ${result.deleted.length} schema(s); skipped ${result.skipped.length}`
    )
    return result
  }

  return {
    list,
    promote,
    downgrade,
    purgeOldSchemas
  }
}
