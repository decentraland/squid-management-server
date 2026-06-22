import { Network } from '@dcl/schemas'
import { AppComponents } from '../../types'
import { Squid } from '../squids/types'
import { AVERAGE_BLOCK_TIME_SECONDS, formatDuration, getBlocksBehind } from '../squids/utils'
import { MOCK_SQUIDS } from './mocks'

export const ETA_CONSIDERED_OUT_OF_SYNC = 100
export const FIVE_MINUTES = 5 * 60 * 1000
export const TEN_MINUTES = 10 * 60 * 1000

export type SlackMessageBlock = {
  type: 'section' | 'header' | 'divider' | 'context'
  text?: {
    type: 'mrkdwn' | 'plain_text'
    text: string
  }
  fields?: Array<{
    type: 'mrkdwn' | 'plain_text'
    text: string
  }>
  elements?: Array<{
    type: 'mrkdwn' | 'plain_text'
    text: string
  }>
  accessory?: {
    type: 'button'
    text: {
      type: 'plain_text'
      text: string
    }
    action_id: string
  }
}

type SquidAlertMessage = {
  text: string
  blocks?: SlackMessageBlock[]
}

// State to track when "no metrics" issues were first detected for throttling alerts
export const noMetricsFirstDetected = new Map<string, number>()

// State to track when the last "out of sync" alert was sent, to throttle them
export const desyncAlertLastSent = new Map<string, number>()

// Helper function to clear throttle state (mainly for testing)
export function clearNoMetricsThrottleState(): void {
  noMetricsFirstDetected.clear()
}

// Helper function to clear desync throttle state (mainly for testing)
export function clearDesyncThrottleState(): void {
  desyncAlertLastSent.clear()
}

// Removes throttle entries for squids that are no longer active (e.g. after a
// blue/green deploy changes the service name), so the throttle maps don't grow
// unbounded over time.
export function pruneThrottleState(activeServiceNames: string[]): void {
  const isActive = (key: string): boolean => activeServiceNames.some(service => key.startsWith(`${service}-`))
  for (const map of [noMetricsFirstDetected, desyncAlertLastSent]) {
    for (const key of Array.from(map.keys())) {
      if (!isActive(key)) {
        map.delete(key)
      }
    }
  }
}

export async function createSquidMonitor(
  components: Pick<AppComponents, 'logs' | 'squids' | 'config' | 'slack'>
): Promise<() => Promise<void>> {
  const { logs, squids, config, slack } = components
  const IS_PRODUCTION = (await config.getString('ENV')) === 'prd'
  const ENV_PREFIX = IS_PRODUCTION ? '[PRD]' : '[DEV]'
  const BASE_URL = IS_PRODUCTION ? 'https://decentraland.org/squid-management-ui' : 'https://decentraland.zone/squid-management-ui'
  const slackChannel = (await config.getString('SLACK_CHANNEL')) || 'general'
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

      // Drop throttle state for squids that are no longer active so the maps stay bounded.
      pruneThrottleState(activeSquids.map(squid => squid.service_name))
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

      const errorSlackMessage: SquidAlertMessage = {
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

      await slack.sendMessage({ channel: slackChannel, ...errorSlackMessage })
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
          const noMetricsMessage: SquidAlertMessage = {
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
          await slack.sendMessage({ channel: slackChannel, ...noMetricsMessage })

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

        const etaUnavailableMessage: SquidAlertMessage = {
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

        await slack.sendMessage({ channel: slackChannel, ...etaUnavailableMessage })
        continue
      }

      // Check if ETA is greater than 100 seconds
      if (metrics.sqd_processor_sync_eta_seconds > ETA_CONSIDERED_OUT_OF_SYNC) {
        const desyncKey = `${squid.service_name}-${network}-desync`
        const now = Date.now()
        const lastSent = desyncAlertLastSent.get(desyncKey)

        // Throttle: (re)send the out-of-sync alert at most once every 10 minutes.
        if (lastSent && now - lastSent < TEN_MINUTES) {
          continue
        }

        const squidDetailsUrl = `${BASE_URL}?squid=${squid.service_name}&network=${network}`

        // How far behind the chain tip the indexer is, in blocks and approximate wall-clock time.
        const blocksBehind = getBlocksBehind(metrics.sqd_processor_last_block, metrics.sqd_processor_chain_height)
        const blockTime = AVERAGE_BLOCK_TIME_SECONDS[network as Network.ETHEREUM | Network.MATIC]
        const behindRealTime = `~${formatDuration(blocksBehind * blockTime)} (≈ ${blockTime}s/block)`

        const desyncMessage: SquidAlertMessage = {
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
                  text: `*⏱️ Sync ETA:* ~${formatDuration(metrics.sqd_processor_sync_eta_seconds)}`
                },
                {
                  type: 'mrkdwn',
                  text: `*📉 Blocks behind:* ${blocksBehind.toLocaleString('en-US')}`
                },
                {
                  type: 'mrkdwn',
                  text: `*🕰️ Behind real-time:* ${behindRealTime}`
                },
                {
                  type: 'mrkdwn',
                  text: `*📦 Last block:* ${metrics.sqd_processor_last_block.toLocaleString('en-US')}`
                },
                {
                  type: 'mrkdwn',
                  text: `*⛓️ Chain height:* ${metrics.sqd_processor_chain_height.toLocaleString('en-US')}`
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

        await slack.sendMessage({ channel: slackChannel, ...desyncMessage })
        desyncAlertLastSent.set(desyncKey, now)
      } else {
        // Back in sync: clear any throttle state so a future desync alerts immediately.
        const desyncKey = `${squid.service_name}-${network}-desync`
        if (desyncAlertLastSent.has(desyncKey)) {
          desyncAlertLastSent.delete(desyncKey)
          logger.info(`Squid ${squid.service_name} on ${network} is back in sync. Clearing desync throttle state.`)
        }
      }
    }
  }

  return monitorSquids
}
