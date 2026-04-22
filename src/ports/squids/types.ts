import { HealthStatus } from '@aws-sdk/client-ecs'
import { Network } from '@dcl/schemas'

export type SquidMetric = {
  sqd_processor_sync_eta_seconds: number
  sqd_processor_chain_height: number
  sqd_processor_last_block: number
  sqd_processor_mapping_blocks_per_second: number
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

export type DatabaseName = 'dapps' | 'credits'

export type PurgeOptions = {
  /** Minimum age (in ms) a schema must have before it is considered for deletion. */
  olderThanMs: number
  /** When true, skip the DROP SCHEMA and only report what would happen. */
  dryRun?: boolean
}

export type PurgedSchema = {
  database: DatabaseName
  schema: string
  ageMs: number
}

export type PurgeSkipReason = 'active' | 'running-service' | 'no-age-info' | 'invalid-name'

export type PurgeResult = {
  deleted: PurgedSchema[]
  skipped: Array<PurgedSchema & { reason: PurgeSkipReason }>
}

export type ISquidComponent = {
  list(): Promise<Squid[]>
  downgrade(serviceName: string): Promise<void>
  promote(serviceName: string): Promise<void>
  purgeOldSchemas(options: PurgeOptions): Promise<PurgeResult>
}
