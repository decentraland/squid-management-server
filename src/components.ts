import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createServerComponent, createStatusCheckComponent } from '@dcl/http-server'
import { createJobComponent } from '@dcl/job-component'
import { createMetricsComponent } from '@dcl/metrics'
import { createPgComponent as createBasePgComponent } from '@dcl/pg-component'
import { createSlackComponent } from '@dcl/slack-component'
import { createTracedFetcherComponent } from '@dcl/traced-fetch-component'
import { metricDeclarations } from './metrics'
import { createPgComponent } from './ports/db/component'
import { createSquidMonitor } from './ports/job/squid-monitor'
import { createSubsquidComponent } from './ports/squids/component'
import { AppComponents, GlobalContext } from './types'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({
    path: ['.env.default', '.env']
  })
  const corsString = await config.requireString('CORS_METHODS')
  const validCORSJsonString = corsString.replace(/'/g, '"')

  const cors = {
    origin: (await config.requireString('CORS_ORIGIN')).split(';').map(origin => new RegExp(origin)),
    methods: JSON.parse(validCORSJsonString),
    credentials: true
  }

  const tracer = createTracerComponent()
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, { cors })
  const statusChecks = await createStatusCheckComponent({ server, config })
  const fetch = await createTracedFetcherComponent({ tracer })

  const dappsDatabase = await createPgComponent(
    { config, logs, metrics },
    {
      dbPrefix: 'DAPPS'
    }
  )

  // for credits database, we use the same user and password as the dapps database
  const creditsDbDatabaseName = await config.requireString('CREDITS_PG_COMPONENT_PSQL_DATABASE')
  const dbUser = await config.requireString('DAPPS_PG_COMPONENT_PSQL_USER')
  const dbPort = await config.requireString('DAPPS_PG_COMPONENT_PSQL_PORT')
  const dbHost = await config.requireString('DAPPS_PG_COMPONENT_PSQL_HOST')
  const dbPassword = await config.requireString('DAPPS_PG_COMPONENT_PSQL_PASSWORD')
  const creditsDatabaseUrl = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${creditsDbDatabaseName}`
  const creditsDatabase = await createBasePgComponent(
    { config, logs, metrics },
    {
      pool: {
        connectionString: creditsDatabaseUrl
      }
    }
  )

  const squids = await createSubsquidComponent({
    fetch,
    dappsDatabase,
    creditsDatabase,
    config,
    logs
  })

  const slackToken = await config.requireString('SLACK_BOT_TOKEN')
  const slack = createSlackComponent({ logs }, { token: slackToken })

  const monitorSquids = await createSquidMonitor({ logs, squids, config, slack })
  const isProduction = (await config.getString('ENV')) === 'prd'
  const squidMonitorLogger = logs.getLogger('squid-monitor-job')
  const squidMonitorJob = createJobComponent({ logs }, isProduction ? monitorSquids : () => Promise.resolve(), 60 * 1000, {
    repeat: isProduction,
    startupDelay: 0,
    onError: error => {
      squidMonitorLogger.error('❌ Error in squid monitor job:', { error: error instanceof Error ? error.message : String(error) })
    }
  })

  const ONE_HOUR_MS = 60 * 60 * 1000
  const ONE_DAY_MS = 24 * ONE_HOUR_MS
  const FIVE_MINUTES_MS = 5 * 60 * 1000
  const DEFAULT_SCHEMA_PURGE_INTERVAL_HOURS = 24
  const schemaPurgeLogger = logs.getLogger('schema-purge-job')
  const schemaPurgeMaxAgeDays = await config.getNumber('SCHEMA_PURGE_MAX_AGE_DAYS')
  const schemaPurgeOlderThanMs = schemaPurgeMaxAgeDays && schemaPurgeMaxAgeDays > 0 ? schemaPurgeMaxAgeDays * ONE_DAY_MS : undefined
  const configuredIntervalHours = await config.getNumber('SCHEMA_PURGE_INTERVAL_HOURS')
  const schemaPurgeIntervalHours =
    configuredIntervalHours && configuredIntervalHours > 0 ? configuredIntervalHours : DEFAULT_SCHEMA_PURGE_INTERVAL_HOURS
  const schemaPurgeIntervalMs = schemaPurgeIntervalHours * ONE_HOUR_MS
  if (schemaPurgeOlderThanMs === undefined) {
    schemaPurgeLogger.info('SCHEMA_PURGE_MAX_AGE_DAYS not set or non-positive; schema purge job is disabled')
  } else {
    schemaPurgeLogger.info(
      `Schema purge enabled: schemas older than ${schemaPurgeMaxAgeDays} day(s), running every ${schemaPurgeIntervalHours} hour(s)`
    )
  }
  const schemaPurgeJob = createJobComponent(
    { logs },
    async () => {
      if (schemaPurgeOlderThanMs === undefined) return
      const result = await squids.purgeOldSchemas({ olderThanMs: schemaPurgeOlderThanMs })
      schemaPurgeLogger.info(`Schema purge: deleted ${result.deleted.length}, skipped ${result.skipped.length}`, {
        deleted: JSON.stringify(result.deleted),
        skipped: JSON.stringify(result.skipped)
      })
    },
    schemaPurgeIntervalMs,
    {
      repeat: true,
      // Delay the first run so it doesn't race with the rest of startup.
      startupDelay: FIVE_MINUTES_MS,
      onError: error => {
        schemaPurgeLogger.error('Schema purge job failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  )

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    dappsDatabase,
    metrics,
    squids,
    slack,
    squidMonitorJob,
    schemaPurgeJob
  }
}
