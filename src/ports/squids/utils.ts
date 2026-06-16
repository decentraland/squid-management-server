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
