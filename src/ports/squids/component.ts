import {
  ECSClient,
  ListServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  ListServicesRequest,
  UpdateServiceCommand,
  DescribeServicesCommand
} from '@aws-sdk/client-ecs'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@well-known-components/pg-component'
import { Network } from '@dcl/schemas'
import { getActiveSchemaQuery, getPromoteQuery, getSchemaByServiceNameQuery } from './queries'
import { ISquidComponent, Squid, SquidMetric } from './types'
import { getMetricValue, getProjectNameFromService, getSquidsNetworksMapping } from './utils'

const AWS_REGION = 'us-east-1'

export async function createSubsquidComponent({
  fetch,
  dappsDatabase,
  config,
  logs
}: {
  fetch: IFetchComponent
  dappsDatabase: IPgComponent
  config: IConfigComponent
  logs: ILoggerComponent
}): Promise<ISquidComponent> {
  const logger = logs.getLogger('squids-component')
  const cluster = await config.requireString('AWS_CLUSTER_NAME')
  const client = new ECSClient({ region: AWS_REGION })

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

          const schemaName = (await dappsDatabase.query(getSchemaByServiceNameQuery(serviceName))).rows[0]?.schema
          const projectActiveSchema = (await dappsDatabase.query(getActiveSchemaQuery(serviceName))).rows[0]?.schema

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

            const ElasticNetworkInterface = 'ElasticNetworkInterface'
            const privateIPv4Address = 'privateIPv4Address'

            const ip = task.attachments
              ?.find(att => att.type === ElasticNetworkInterface)
              ?.details?.find(detail => detail.name === privateIPv4Address)?.value

            if (!ip) continue

            // Fetch metrics for each network in parallel
            try {
              const metricsResults = await Promise.allSettled(
                getSquidsNetworksMapping().map(async network => {
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
                  logger.error(`Failed to fetch metrics for network ${getSquidsNetworksMapping()[index].name}:`, result.reason)
                }
              })
            } catch (error) {
              logger.error(`Failed to fetch metrics for ${ip}:`, { error: String(error) })
            }
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
      logger.info(`Service ${serviceName} stopped!`)
    } catch (error) {
      logger.error('Error stopping service:', { error: String(error), service: serviceName })
    }
  }

  async function promote(serviceName: string): Promise<void> {
    const projectName = getProjectNameFromService(serviceName) // e.g: service name is marketplace-squid-server-a-blue-92e812a, project is marketplace
    const schemaName = `squid_${projectName}` // e.g: squid_marketplace
    const promoteQuery = getPromoteQuery(serviceName, schemaName, projectName)

    // NOTE: in the future, depending on the project we might want to run the promote query in a different db
    await dappsDatabase.query(promoteQuery)
    logger.info(`The ${serviceName} was promoted and the active schema is ${schemaName}`)

    // Call marketplace server to recreate triggers and refresh materialized view for marketplace or trades squids
    if (serviceName.includes('marketplace-squid-server') || serviceName.includes('trades-squid-server')) {
      try {
        const marketplaceServerUrl = await config.getString('MARKETPLACE_SERVER_URL')
        if (!marketplaceServerUrl) {
          console.warn('MARKETPLACE_SERVER_URL not configured, skipping materialized view recreation')
          return
        }

        const apiToken = await config.getString('MARKETPLACE_SERVER_TRADES_API_TOKEN')
        if (!apiToken) {
          console.warn('MARKETPLACE_SERVER_TRADES_API_TOKEN not configured, skipping materialized view recreation')
          return
        }

        const response = await fetch.fetch(`${marketplaceServerUrl}/v1/trades/materialized-view/recreate`, {
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

  return {
    list,
    promote,
    downgrade
  }
}
