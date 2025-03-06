// This file is the "test-environment" analogous for src/components.ts
// Here we define the test components to be used in the testing environment
import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { createRunner, createLocalFetchCompoment } from '@well-known-components/test-helpers'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createFetchComponent } from '../src/adapters/fetch'
import { metricDeclarations } from '../src/metrics'
import { createPgComponent } from '../src/ports/db/component'
import { createSubsquidComponent } from '../src/ports/squids/component'
import { main } from '../src/service'
import { GlobalContext, TestComponents } from '../src/types'
import { createSlackComponent } from '../src/ports/slack'
import { createSquidMonitorJob } from '../src/ports/job/squid-monitor'

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
    methods: await config.requireString('CORS_METHODS')
  }
  const tracer = createTracerComponent()
  const fetch = await createFetchComponent({ tracer })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const logs = await createLogComponent({ metrics })
  const server = await createServerComponent<GlobalContext>({ config, logs }, { cors })

  const dappsDatabase = await createPgComponent(
    { config, logs, metrics },
    {
      dbPrefix: 'DAPPS'
    }
  )
  const squids = await createSubsquidComponent({
    fetch,
    dappsDatabase,
    config
  })
  const slack = await createSlackComponent({ config })
  const squidMonitorJob = await createSquidMonitorJob({ config, logs, squids, slack })

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
    squidMonitorJob
  }
}
