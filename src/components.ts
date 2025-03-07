import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { createServerComponent, createStatusCheckComponent } from '@well-known-components/http-server'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createFetchComponent } from './adapters/fetch'
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
  const fetch = await createFetchComponent({ tracer })

  const dappsDatabase = await createPgComponent(
    { config, logs, metrics },
    {
      dbPrefix: 'DAPPS'
    }
  )
  const squids = await createSubsquidComponent({
    fetch,
    dappsDatabase,
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
