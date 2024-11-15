import { Network } from '@dcl/schemas'

export const getMetricValue = (metrics: string, metricName: string) => {
  const regex = new RegExp(`${metricName}\\s+(\\d+\\.?\\d*)`)
  const match = metrics.match(regex)
  return match ? parseFloat(match[1]) : 0
}

export function getSquidsNetworksMapping(): {
  name: Network.ETHEREUM | Network.MATIC
  port: number
}[] {
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
