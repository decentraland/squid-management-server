import {
  ECSClient,
  ListServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  ListServicesRequest,
  UpdateServiceCommand,
  DescribeServicesCommand
} from '@aws-sdk/client-ecs'
import { IConfigComponent, IFetchComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@well-known-components/pg-component'
import { Network } from '@dcl/schemas'
import { getPromoteQuery } from './queries'
import { ISquidComponent, Squid, SquidMetric } from './types'
import { getMetricValue, getSquidsNetworksMapping } from './utils'

const AWS_REGION = 'us-east-1'

export async function createSubsquidComponent({
  fetch,
  dappsDatabase,
  config
}: {
  fetch: IFetchComponent
  dappsDatabase: IPgComponent
  config: IConfigComponent
}): Promise<ISquidComponent> {
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

      // Step 2: Get tasks for each service and fetch task IPs
      const results: Squid[] = []

      const describeServicesCommand = new DescribeServicesCommand({
        cluster,
        services: squidServices
      })

      const describeServicesResponse = await client.send(describeServicesCommand)

      for (const squidService of describeServicesResponse.services || []) {
        const serviceName = squidService.serviceName
        const listTasksCommand = new ListTasksCommand({
          cluster,
          serviceName
        })
        const taskResponse = await client.send(listTasksCommand)
        const taskArns = taskResponse.taskArns || []

        if (taskArns.length === 0) continue

        const describeTasksCommand = new DescribeTasksCommand({
          cluster,
          tasks: taskArns
        })
        const describeResponse = await client.send(describeTasksCommand)
        const tasks = describeResponse.tasks || []

        const squid: Partial<Squid> = {
          name: squidService.serviceName || '',
          service_name: squidService.serviceName || '',
          metrics: {} as Record<Network.ETHEREUM | Network.MATIC, SquidMetric>
        }

        // there should be just one task per service
        for (const task of tasks) {
          squid.version = task.version || 0
          squid.created_at = task.createdAt
          squid.health_status = task.healthStatus
          squid.service_status = task.lastStatus

          const ip = task.attachments
            ?.find(att => att.type === 'ElasticNetworkInterface')
            ?.details?.find(detail => detail.name === 'privateIPv4Address')?.value

          if (!ip) continue

          // Step 3: Fetch /metrics from each IP for each network
          try {
            for (const network of getSquidsNetworksMapping()) {
              const response = await fetch.fetch(`http://${ip}:${network.port}/metrics`)
              const text = await response.text() // Use text() since the response is plain text

              if (!squid.metrics) {
                squid.metrics = {} as Record<Network.ETHEREUM | Network.MATIC, SquidMetric>
              }

              squid.metrics[network.name] = {
                sqd_processor_sync_eta_seconds: getMetricValue(text, 'sqd_processor_sync_eta_seconds'),
                sqd_processor_mapping_blocks_per_second: getMetricValue(text, 'sqd_processor_mapping_blocks_per_second'),
                sqd_processor_last_block: getMetricValue(text, 'sqd_processor_last_block'),
                sqd_processor_chain_height: getMetricValue(text, 'sqd_processor_chain_height')
              }
            }
          } catch (error) {
            console.error(`Failed to fetch metrics for ${ip}:`, error)
          }
          if (squid.created_at && squid.health_status && squid.service_status) {
            results.push(squid as Squid)
          } else {
            console.warn(`Skipping incomplete squid: ${squid.service_name}`)
          }
        }
      }

      return results
    } catch (error) {
      console.error('Error listing services:', error)
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
      const updateServiceResponse = await client.send(updateServiceCommand)
      console.log('updateServiceResponse: ', updateServiceResponse) // @TODO: refactor this, for now just print it to the console
    } catch (error) {
      console.log('error: ', error)
    }
  }

  async function promote(serviceName: string): Promise<void> {
    try {
      const projectName = serviceName.split('-')[0] // e.g: service name is marketplace-squid-server-a-blue-92e812a, project is marketplace
      const schemaName = `squid_${projectName}` // e.g: squid_marketplace
      const promoteQuery = getPromoteQuery(serviceName, schemaName, projectName)

      const result = await dappsDatabase.query(promoteQuery)
      console.log('result: ', result) // @TODO implement a proper response
    } catch (error) {
      console.log('error: ', error)
    }
  }

  return {
    list,
    promote,
    downgrade
  }
}
