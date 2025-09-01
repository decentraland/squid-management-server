import { Network } from '@dcl/schemas'
import { AppComponents } from '../../types'
import { SlackMessage } from '../slack/component'
import { Squid } from '../squids/types'
import { createJobComponent } from './component'
import { MOCK_SQUIDS } from './mocks'
import { IJobComponent } from './types'

const ONE_MINUTE = 60 * 1000
export const ETA_CONSIDERED_OUT_OF_SYNC = 100
export const FIVE_MINUTES = 5 * 60 * 1000

// State to track when "no metrics" issues were first detected for throttling alerts
export const noMetricsFirstDetected = new Map<string, number>()

// Helper function to clear throttle state (mainly for testing)
export function clearNoMetricsThrottleState(): void {
  noMetricsFirstDetected.clear()
}

export async function createSquidMonitorJob(
  components: Pick<AppComponents, 'logs' | 'squids' | 'config' | 'slack'>
): Promise<IJobComponent> {
  const { logs, squids, config, slack } = components
  const IS_PRODUCTION = (await config.getString('ENV')) === 'prd'
  const ENV_PREFIX = IS_PRODUCTION ? '[PRD]' : '[DEV]'
  const BASE_URL = IS_PRODUCTION ? 'https://decentraland.org/squid-management-ui' : 'https://decentraland.zone/squid-management-ui'
  const logger = logs.getLogger('squid-monitor')

  const MOCK_ENABLED = (await config.getString('USE_MOCK_SQUIDS')) === 'true' //  this is for testing locally
  const FORCE_ETA_UNAVAILABLE = (await config.getString('FORCE_ETA_UNAVAILABLE')) === 'true' //  this is for testing locally

  async function monitorSquids() {
    try {
      logger.info('🦑 Monitoring squids...')

      // Use mock data if enabled, otherwise fetch real data
      const allSquids = MOCK_ENABLED ? MOCK_SQUIDS : await squids.list()

      // Filter active squids (schema_name === project_active_schema)
      const activeSquids = allSquids.filter(squid => squid.schema_name === squid.project_active_schema)

      logger.info(`🔍 Found ${activeSquids.length} active squids`)

      for (const squid of activeSquids) {
        await checkSquidSynchronization(squid)
      }
    } catch (error) {
      logger.error('❌ Error monitoring squids:', { error: formatError(error) })

      let errorMessage = 'Unknown error'
      if (error instanceof Error) {
        errorMessage = error.message
      } else if (typeof error === 'string') {
        errorMessage = error
      } else if (error && typeof error === 'object') {
        try {
          errorMessage = JSON.stringify(error)
        } catch {
          errorMessage = 'Non-serializable error'
        }
      }

      const errorSlackMessage: SlackMessage = {
        text: `${ENV_PREFIX} 🚨 ERROR: There was a problem monitoring the Squids`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `${ENV_PREFIX} 🚨 ERROR: Squid Monitoring`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*❌ There was a problem monitoring the Squids:* ${errorMessage}`
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `*🕒 Date:* ${new Date().toLocaleString()}`
              }
            ]
          }
        ]
      }

      await slack.sendFormattedMessage(errorSlackMessage)
    }
  }

  // Helper function to format errors for logging
  function formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    } else if (typeof error === 'string') {
      return error
    } else if (error && typeof error === 'object') {
      try {
        return JSON.stringify(error)
      } catch {
        return 'Non-serializable error'
      }
    }
    return 'Unknown error'
  }

  async function checkSquidSynchronization(squid: Squid) {
    // We only check ETHEREUM and MATIC networks which are the ones in the type
    let validNetworks = [Network.ETHEREUM, Network.MATIC]
    if (squid.service_name.includes('credits')) {
      validNetworks = [Network.MATIC] as const
    }

    // Only check active squids (schema_name === project_active_schema)
    if (squid.schema_name !== squid.project_active_schema) {
      return
    }

    for (const network of validNetworks) {
      const metrics = squid.metrics[network as Network.ETHEREUM | Network.MATIC]
      const squidDetailsUrl = `${BASE_URL}?squid=${squid.service_name}&network=${network}`
      const noMetricsKey = `${squid.service_name}-${network}-no-metrics`

      if (!metrics) {
        logger.warn(`No metrics found for squid ${squid.service_name} on network ${network}`)

        const now = Date.now()
        const firstDetected = noMetricsFirstDetected.get(noMetricsKey)
        if (!firstDetected) {
          // First time detecting this issue, record the timestamp
          noMetricsFirstDetected.set(noMetricsKey, now)
          logger.info(`First detection of no metrics for ${squid.service_name} on ${network}. Will send alert after 5 minutes.`)
        } else if (now - firstDetected >= FIVE_MINUTES) {
          // Issue has persisted for 5 minutes, send the alert
          const noMetricsMessage: SlackMessage = {
            text: `${ENV_PREFIX} ⚠️ ALERT: No metrics found for Squid '${squid.name}' on network ${network}`,
            blocks: [
              {
                type: 'header',
                text: {
                  type: 'plain_text',
                  text: `${ENV_PREFIX} ⚠️ ALERT: No metrics found`
                }
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*🆔 ID:* ${squid.service_name}`
                }
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*⏰ Issue duration:* ${Math.round((now - firstDetected) / 60000)} minutes`
                }
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `*🕒 Date:* ${new Date().toLocaleString()}`
                  }
                ]
              },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*⚙️ Please check the Squid status:* <${squidDetailsUrl}|View Details>`
                }
              }
            ]
          }
          await slack.sendFormattedMessage(noMetricsMessage)

          // Reset the timestamp to avoid spamming (will only send again after another 5 minutes)
          noMetricsFirstDetected.set(noMetricsKey, now)
        }
        continue
      } else {
        // Metrics found, clear any stored "no metrics" detection for this squid+network
        if (noMetricsFirstDetected.has(noMetricsKey)) {
          noMetricsFirstDetected.delete(noMetricsKey)
          logger.info(`Metrics recovered for ${squid.service_name} on ${network}. Clearing throttle state.`)
        }
      }

      // For testing: force ETA to be undefined if environment variable is set
      if (FORCE_ETA_UNAVAILABLE && MOCK_ENABLED && network === Network.MATIC) {
        // @ts-expect-error - Intentionally setting to undefined for testing
        metrics.sqd_processor_sync_eta_seconds = undefined
      }

      // Check if ETA is null or undefined
      if (metrics.sqd_processor_sync_eta_seconds === null || metrics.sqd_processor_sync_eta_seconds === undefined) {
        const squidDetailsUrl = `${BASE_URL}?squid=${squid.service_name}&network=${network}`

        const etaUnavailableMessage: SlackMessage = {
          text: `${ENV_PREFIX} ⚠️ ALERT: Cannot read ETA for Squid '${squid.name}' on network ${network}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `${ENV_PREFIX} ⚠️ ALERT: ETA unavailable`
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `🔍 Cannot read ETA for Squid *${squid.name}* on network *${network}*`
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*🆔 ID:* ${squid.service_name}`
                },
                {
                  type: 'mrkdwn',
                  text: `*📊 Schema:* ${squid.schema_name}`
                }
              ]
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*⚙️ Please check the Squid status:* <${squidDetailsUrl}|View Details>`
              }
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*🕒 Date:* ${new Date().toLocaleString()}`
                }
              ]
            }
          ]
        }

        await slack.sendFormattedMessage(etaUnavailableMessage)
        continue
      }

      // Check if ETA is greater than 100 seconds
      if (metrics.sqd_processor_sync_eta_seconds > ETA_CONSIDERED_OUT_OF_SYNC) {
        const squidDetailsUrl = `${BASE_URL}?squid=${squid.service_name}&network=${network}`

        const desyncMessage: SlackMessage = {
          text: `${ENV_PREFIX} ⚠️ ALERT: Squid '${squid.name}' on network ${network} is out of sync`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `${ENV_PREFIX} ⚠️ ALERT: Squid out of sync`
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `🔄 Squid *${squid.name}* on network *${network}* is out of sync`
              }
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*🆔 ID:* ${squid.service_name}`
                },
                {
                  type: 'mrkdwn',
                  text: `*📊 Schema:* ${squid.schema_name}`
                },
                {
                  type: 'mrkdwn',
                  text: `*⏱️ Current ETA:* ${metrics.sqd_processor_sync_eta_seconds} seconds`
                },
                {
                  type: 'mrkdwn',
                  text: `*📦 Last block:* ${metrics.sqd_processor_last_block}`
                },
                {
                  type: 'mrkdwn',
                  text: `*⛓️ Chain height:* ${metrics.sqd_processor_chain_height}`
                }
              ]
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*🛠️ Actions:* <${squidDetailsUrl}|View Details>`
              }
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `*🕒 Date:* ${new Date().toLocaleString()}`
                }
              ]
            }
          ]
        }

        await slack.sendFormattedMessage(desyncMessage)
      }
    }
  }

  return createJobComponent(components, IS_PRODUCTION ? monitorSquids : () => Promise.resolve(), ONE_MINUTE, {
    repeat: IS_PRODUCTION,
    startupDelay: 0,
    onError: error => {
      logger.error('❌ Error in squid monitor job:', { error: formatError(error) })
    }
  })
}
