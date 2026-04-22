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

/**
 * Identifies which of the two databases the squid component talks to.
 * Used as an explicit label in purge results and logs so that mixed-DB
 * outputs remain unambiguous.
 */
export type DatabaseName = 'dapps' | 'credits'

export type PurgeOptions = {
  /** Minimum age (in ms) a schema must have before it is considered for deletion. */
  olderThanMs: number
  /** When true, skip the DROP SCHEMA and only report what would happen. */
  dryRun?: boolean
}

/**
 * A schema that met the age threshold and was either dropped (listed under
 * `deleted`) or protected from dropping (listed under `skipped`, with a
 * `reason` tag). Age is the time in ms since the most recent
 * `indexers.created_at` for that schema.
 */
export type PurgedSchema = {
  database: DatabaseName
  schema: string
  ageMs: number
}

/**
 * Why an old schema was kept instead of dropped.
 *
 * - `active`: the schema is the one currently promoted for some project
 *   (row in `public.squids`). Dropping it would take down reads.
 * - `running-service`: the schema is the latest deployment for an ECS squid
 *   service that currently has a running task, i.e. it could be promoted
 *   at any moment.
 * - `no-age-info`: no `indexers` row references this schema. We can't
 *   prove we created it and therefore refuse to touch it. In practice this
 *   entry will not appear in the result — such schemas are silently
 *   ignored — but the reason is reserved in case a future change surfaces
 *   them for visibility.
 * - `invalid-name`: the schema name does not match the safety regex
 *   `^squid_[a-zA-Z0-9_]+$`. Reserved for the same reason as
 *   `no-age-info`: a defensive tag that can be surfaced later.
 */
export type PurgeSkipReason = 'active' | 'running-service' | 'no-age-info' | 'invalid-name'

/**
 * Outcome of a `purgeOldSchemas` run. `deleted` lists what was actually
 * dropped (or would be dropped, when called with `dryRun: true`). `skipped`
 * lists schemas that were old enough but protected; see `PurgeSkipReason`.
 * Failures at DROP time are logged at `error` level and do not appear in
 * either array.
 */
export type PurgeResult = {
  deleted: PurgedSchema[]
  skipped: Array<PurgedSchema & { reason: PurgeSkipReason }>
}

export type ISquidComponent = {
  list(): Promise<Squid[]>
  downgrade(serviceName: string): Promise<void>
  promote(serviceName: string): Promise<void>
  /**
   * Sweeps both databases for `squid_*` schemas that are older than
   * `olderThanMs`, dropping the ones that are not currently promoted and
   * not the latest deployment of a running ECS service.
   *
   * Safety rails:
   * - Aborts without touching any database if the ECS call for running
   *   services fails or returns an empty list.
   * - Every schema name is matched against a strict regex before DROP.
   * - Drops run inside a per-schema transaction so a failure rolls back
   *   both the `DROP SCHEMA` and the accompanying `DELETE FROM
   *   public.indexers`.
   * - A failure dropping one schema is logged and the caller continues
   *   with the next schema.
   *
   * @see PurgeOptions, PurgeResult
   */
  purgeOldSchemas(options: PurgeOptions): Promise<PurgeResult>
}
