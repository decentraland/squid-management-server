import { HealthStatus } from '@aws-sdk/client-ecs'
import { Network } from '@dcl/schemas'

export type SquidMetric = {
  sqd_processor_sync_eta_seconds: number
  sqd_processor_chain_height: number
  sqd_processor_last_block: number
  sqd_processor_mapping_blocks_per_second: number
  // Derived field (not scraped): percentage of the chain indexed, in the [0, 100] range.
  progress: number
}

export type Squid = {
  name: string
  service_name: string
  schema_name: string
  project_active_schema: string
  created_at: Date | undefined
  health_status: HealthStatus | undefined
  service_status: string | undefined
  version: number
  image_uri?: string
  metrics: Record<Network.ETHEREUM | Network.MATIC, SquidMetric>
}

/**
 * The "slow-moving" description of a squid service: everything that comes from ECS
 * and the indexers/squids tables. It deliberately excludes the live processor
 * metrics, which are scraped fresh on every request. This is what the component
 * caches so that frequent polling does not hammer the ECS API.
 */
export type SquidServiceTopology = {
  service_name: string
  schema_name?: string
  project_active_schema?: string
  version: number
  created_at?: Date
  health_status?: HealthStatus
  service_status?: string
  image_uri?: string
  ip?: string
  networks: { name: Network.ETHEREUM | Network.MATIC; port: number }[]
}

export type SlotService = {
  service: string
  schema: string
}

export type IsLiveResult = {
  live: boolean
  activeSchema: string | null
  liveService: string | null
  services: SlotService[]
}

export type ISquidComponent = {
  list(): Promise<Squid[]>
  downgrade(serviceName: string): Promise<void>
  promote(serviceName: string): Promise<void>
  isLive(project: string, slot: string): Promise<IsLiveResult>
}
