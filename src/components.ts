import { createDotEnvConfigComponent } from "@well-known-components/env-config-provider";
import {
  createServerComponent,
  createStatusCheckComponent,
} from "@well-known-components/http-server";
import { createLogComponent } from "@well-known-components/logger";
import { metricDeclarations } from "./metrics";
import { createMetricsComponent } from "@well-known-components/metrics";
import { createSubgraphComponent } from "@well-known-components/thegraph-component";
import { createTracerComponent } from "@well-known-components/tracer-component";
import { AppComponents, GlobalContext } from "./types";
import { createSubsquidComponent } from "./ports/squids/component";
import { createPgComponent } from "./ports/db/component";
import { createFetchComponent } from "./adapters/fetch";

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({
    path: [".env.default", ".env"],
  });
  const cors = {
    origin: (await config.requireString("CORS_ORIGIN"))
      .split(";")
      .map((origin) => new RegExp(origin)),
    methods: await config.requireString("CORS_METHODS"),
  };
  const tracer = createTracerComponent();
  const metrics = await createMetricsComponent(metricDeclarations, { config });
  const logs = await createLogComponent({ metrics });
  const server = await createServerComponent<GlobalContext>(
    { config, logs },
    { cors }
  );
  const statusChecks = await createStatusCheckComponent({ server, config });
  const fetch = await createFetchComponent({ tracer });

  const dappsDatabase = await createPgComponent(
    { config, logs, metrics },
    {
      dbPrefix: "DAPPS",
    }
  );
  const squids = await createSubsquidComponent({
    fetch,
    dappsDatabase,
    config,
  });

  return {
    config,
    logs,
    server,
    statusChecks,
    fetch,
    dappsDatabase,
    metrics,
    squids,
  };
}
