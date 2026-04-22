import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createServerComponent, createStatusCheckComponent } from '@dcl/http-server'
import { createMetricsComponent } from '@dcl/metrics'
import { createPgComponent as createBasePgComponent } from '@dcl/pg-component'
import { createTracedFetcherComponent } from '@dcl/traced-fetch-component'
import { metricDeclarations } from './metrics'
import { createPgComponent } from './ports/db/component'
import { createSquidMonitorJob } from './ports/job/squid-monitor'
import { createSlackComponent } from './ports/slack/component'
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

  const slack = await createSlackComponent({
    config,
    logs
  })

  const squidMonitorJob = await createSquidMonitorJob({ logs, squids, config, slack })

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
    squidMonitorJob
  }
}
