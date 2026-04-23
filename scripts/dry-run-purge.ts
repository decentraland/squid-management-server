/**
 * Dry-run the schema purge against a live pair of databases and print what
 * would happen without executing anything destructive.
 *
 * Usage:
 *   npm run dry-run:purge                 # reads SCHEMA_PURGE_MAX_AGE_DAYS from env
 *   SCHEMA_PURGE_MAX_AGE_DAYS=90 npm run dry-run:purge
 *
 * Requires the same env the server does (DAPPS_*, CREDITS_*, AWS_CLUSTER_NAME
 * and AWS credentials). Reads .env.default + .env from the repo root.
 */
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createMetricsComponent } from '@dcl/metrics'
import { createPgComponent as createBasePgComponent } from '@dcl/pg-component'
import { createTracedFetcherComponent } from '@dcl/traced-fetch-component'
import { metricDeclarations } from '../src/metrics'
import { createPgComponent } from '../src/ports/db/component'
import { createSubsquidComponent } from '../src/ports/squids/component'
import { PurgeResult } from '../src/ports/squids/types'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })

  const maxAgeDays = await config.getNumber('SCHEMA_PURGE_MAX_AGE_DAYS')
  if (!maxAgeDays || maxAgeDays <= 0) {
    console.error('SCHEMA_PURGE_MAX_AGE_DAYS is not set or non-positive — set it to the threshold you want to evaluate and rerun.')
    process.exit(1)
  }
  const olderThanMs = maxAgeDays * ONE_DAY_MS

  const tracer = createTracerComponent()
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const fetch = await createTracedFetcherComponent({ tracer })

  const dappsDatabase = await createPgComponent({ config, logs, metrics }, { dbPrefix: 'DAPPS' })

  // Mirrors src/components.ts: credits reuses the DAPPS user / password / host
  // / port but with its own database name.
  const creditsDbDatabaseName = await config.requireString('CREDITS_PG_COMPONENT_PSQL_DATABASE')
  const dbUser = await config.requireString('DAPPS_PG_COMPONENT_PSQL_USER')
  const dbPort = await config.requireString('DAPPS_PG_COMPONENT_PSQL_PORT')
  const dbHost = await config.requireString('DAPPS_PG_COMPONENT_PSQL_HOST')
  const dbPassword = await config.requireString('DAPPS_PG_COMPONENT_PSQL_PASSWORD')
  const creditsDatabaseUrl = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${creditsDbDatabaseName}`
  const creditsDatabase = await createBasePgComponent({ config, logs, metrics }, { pool: { connectionString: creditsDatabaseUrl } })

  if (dappsDatabase.start) await dappsDatabase.start()
  if (creditsDatabase.start) await creditsDatabase.start()

  const squids = await createSubsquidComponent({ fetch, dappsDatabase, creditsDatabase, config, logs })

  console.log('Schema purge — DRY RUN (nothing will be deleted)')
  console.log(`Threshold: ${maxAgeDays} day(s) (${olderThanMs.toLocaleString()} ms)`)
  console.log()

  let result: PurgeResult
  try {
    result = await squids.purgeOldSchemas({ olderThanMs, dryRun: true })
  } finally {
    if (dappsDatabase.stop) await dappsDatabase.stop()
    if (creditsDatabase.stop) await creditsDatabase.stop()
  }

  printResult(result)
  // Explicitly exit so any stray AWS SDK / pg-pool handles don't keep the
  // process alive.
  process.exit(0)
}

function toDays(ms: number): string {
  return (ms / ONE_DAY_MS).toFixed(1)
}

function printResult(result: PurgeResult): void {
  console.log(`Would delete ${result.deleted.length} schema(s):`)
  if (result.deleted.length === 0) {
    console.log('  (none)')
  } else {
    for (const entry of result.deleted) {
      console.log(`  ${entry.database.padEnd(8)} ${entry.schema.padEnd(40)} age=${toDays(entry.ageMs)} day(s)`)
    }
  }

  console.log()
  console.log(`Skipped ${result.skipped.length} schema(s) that are old enough but protected:`)
  if (result.skipped.length === 0) {
    console.log('  (none)')
  } else {
    for (const entry of result.skipped) {
      console.log(
        `  ${entry.database.padEnd(8)} ${entry.schema.padEnd(40)} reason=${entry.reason.padEnd(16)} age=${toDays(entry.ageMs)} day(s)`
      )
    }
  }
}

main().catch(error => {
  console.error('Dry-run failed:', error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
