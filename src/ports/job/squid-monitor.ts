import { Network } from '@dcl/schemas'
import { AppComponents } from '../../types'
import { SlackMessage } from '../slack/component'
import { Squid } from '../squids/types'
import { createJobComponent } from './component'
import { MOCK_SQUIDS } from './mocks'
import { IJobComponent } from './types'

const ONE_MINUTE = 60 * 1000
export const ETA_CONSIDERED_OUT_OF_SYNC = 100

// Environment detection
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const ENV_PREFIX = IS_PRODUCTION ? '[PRD]' : '[DEV]'
const BASE_URL = IS_PRODUCTION ? 'https://decentraland.org/squid-management-ui' : 'https://decentraland.zone/squid-management-ui'

export async function createSquidMonitorJob(
  components: Pick<AppComponents, 'logs' | 'squids' | 'config' | 'slack'>
): Promise<IJobComponent> {
  const { logs, squids, config, slack } = components
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
    const validNetworks = [Network.ETHEREUM, Network.MATIC] as const

    // Only check active squids (schema_name === project_active_schema)
    if (squid.schema_name !== squid.project_active_schema) {
      return
    }

    for (const network of validNetworks) {
      const metrics = squid.metrics[network as Network.ETHEREUM | Network.MATIC]
      const squidDetailsUrl = `${BASE_URL}?squid=${squid.service_name}&network=${network}`
      if (!metrics) {
        logger.warn(`No metrics found for squid ${squid.service_name} on network ${network}`)
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
        continue
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

  return createJobComponent(components, monitorSquids, ONE_MINUTE, {
    repeat: true,
    startupDelay: 0,
    onError: error => {
      logger.error('❌ Error in squid monitor job:', { error: formatError(error) })
    }
  })
}
