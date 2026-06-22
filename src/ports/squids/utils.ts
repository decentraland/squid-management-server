import { Network } from '@dcl/schemas'

export const getMetricValue = (metrics: string, metricName: string) => {
  const regex = new RegExp(`${metricName}\\s+(\\d+\\.?\\d*)`)
  const match = metrics.match(regex)
  return match ? parseFloat(match[1]) : 0
}

/**
 * Computes the indexing progress as the percentage of the chain height that has
 * already been processed by the squid (last processed block / chain height).
 *
 * @param lastBlock - The last block processed by the indexer (sqd_processor_last_block).
 * @param chainHeight - The current chain tip the indexer is syncing towards (sqd_processor_chain_height).
 * @returns A value in the [0, 100] range rounded to 2 decimals. Returns 0 when the
 *          chain height is unknown (0) to avoid a division by zero.
 */
export const computeSyncProgress = (lastBlock: number, chainHeight: number): number => {
  if (!chainHeight || chainHeight <= 0) {
    return 0
  }
  const percentage = (lastBlock / chainHeight) * 100
  return Math.min(100, Math.max(0, Math.round(percentage * 100) / 100))
}

/**
 * Approximate average block time per network, in seconds. Used to translate a
 * block lag (chain height - last processed block) into an approximate wall-clock
 * "behind real-time" figure.
 *
 * Sources (June 2026): Ethereum slots are a fixed 12s post-merge; Polygon PoS
 * reduced its average block time to ~1.75s in May 2026 (down from ~2s). Update
 * these if the networks change their cadence.
 */
export const AVERAGE_BLOCK_TIME_SECONDS: Record<Network.ETHEREUM | Network.MATIC, number> = {
  [Network.ETHEREUM]: 12,
  [Network.MATIC]: 1.75
}

/**
 * Returns how many blocks the indexer is behind the chain tip, clamped to 0 so a
 * momentarily stale chain height (last block > chain height) never goes negative.
 */
export const getBlocksBehind = (lastBlock: number, chainHeight: number): number => Math.max(0, chainHeight - lastBlock)

/**
 * Formats a duration in seconds into a short, human-readable string showing the
 * two most significant units (e.g. "1h 13m", "46m 27s", "45s"). Returns "0s" for
 * non-positive durations.
 */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0s'
  }

  const total = Math.round(seconds)
  const units = [
    { value: Math.floor(total / 86400), label: 'd' },
    { value: Math.floor((total % 86400) / 3600), label: 'h' },
    { value: Math.floor((total % 3600) / 60), label: 'm' },
    { value: total % 60, label: 's' }
  ]

  const firstIndex = units.findIndex(unit => unit.value > 0)
  if (firstIndex === -1) {
    return '0s'
  }

  return units
    .slice(firstIndex, firstIndex + 2)
    .filter(unit => unit.value > 0)
    .map(unit => `${unit.value}${unit.label}`)
    .join(' ')
}

export const getProjectNameFromService = (serviceName: string): string => serviceName.split('-squid-server-')[0]

export function getSquidsNetworksMapping(serviceName: string): {
  name: Network.ETHEREUM | Network.MATIC
  port: number
}[] {
  const projectName = getProjectNameFromService(serviceName)

  if (projectName === 'credits') {
    return [
      {
        name: Network.MATIC,
        port: 3001
      }
    ]
  }

  return [
    {
      name: Network.ETHEREUM,
      port: 3000
    },
    {
      name: Network.MATIC,
      port: 3001
    }
  ]
}
