// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createLogComponent } from '@well-known-components/logger'
import { createLocalFetchCompoment, createRunner } from '@well-known-components/test-helpers'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createServerComponent } from '@dcl/http-server'
import { createJobComponent } from '@dcl/job-component'
import { createMetricsComponent } from '@dcl/metrics'
import { createPgComponent as createBasePgComponent } from '@dcl/pg-component'
import { createSlackComponent } from '@dcl/slack-component'
import { createTracedFetcherComponent } from '@dcl/traced-fetch-component'
import { metricDeclarations } from '../src/metrics'
import { createPgComponent } from '../src/ports/db/component'
import { createSquidMonitor } from '../src/ports/job/squid-monitor'
import { createSubsquidComponent } from '../src/ports/squids/component'
import { main } from '../src/service'
import { GlobalContext, TestComponents } from '../src/types'

/**
 * Behaves like Jest "describe" function, used to describe a test for a
 * use case, it creates a whole new program and components to run an
 * isolated test.
 *
 * State is persistent within the steps of the test.
 */
export const test = createRunner<TestComponents>({
  main,
  initComponents
})

async function initComponents(): Promise<TestComponents> {
  const config = await createDotEnvConfigComponent({
    path: ['.env.default', '.env.spec', '.env']
  })
  const cors = {
    origin: await config.requireString('CORS_ORIGIN'),
    methods: (await config.requireString('CORS_METHODS')).split(',').map(method => method.trim())
  }
  const tracer = createTracerComponent()
  const fetch = await createTracedFetcherComponent({ tracer })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, { cors })

  const dappsDatabase = await createPgComponent(
    { config, logs, metrics },
    {
      dbPrefix: 'DAPPS'
    }
  )

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
  const monitorSquids = await createSquidMonitor({ config, logs, squids, slack })
  const squidMonitorJob = createJobComponent({ logs }, monitorSquids, 60 * 1000, { repeat: false })
  const schemaPurgeJob = createJobComponent({ logs }, () => Promise.resolve(), 24 * 60 * 60 * 1000, { repeat: false })

  return {
    config,
    logs,
    server,
    localFetch: await createLocalFetchCompoment(config),
    fetch,
    dappsDatabase,
    metrics,
    squids,
    slack,
    squidMonitorJob,
    schemaPurgeJob
  }
}
