import { IBaseComponent, IConfigComponent, ILoggerComponent, IMetricsComponent } from '@well-known-components/interfaces'
import { IPgComponent, Options, createPgComponent as createBasePgComponent } from '@dcl/pg-component'

type NeededComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  metrics?: IMetricsComponent<string>
}

export async function createPgComponent(
  components: NeededComponents,
  options: { dbPrefix: string } & Options
): Promise<IPgComponent & IBaseComponent> {
  const { dbPrefix, ...rest } = options
  let databaseUrl: string | undefined = await components.config.getString(`${dbPrefix}_PG_COMPONENT_PSQL_CONNECTION_STRING`)
  if (!databaseUrl) {
    const dbUser = await components.config.requireString(`${dbPrefix}_PG_COMPONENT_PSQL_USER`)
    const dbDatabaseName = await components.config.requireString(`${dbPrefix}_PG_COMPONENT_PSQL_DATABASE`)
    const dbPort = await components.config.requireString(`${dbPrefix}_PG_COMPONENT_PSQL_PORT`)
    const dbHost = await components.config.requireString(`${dbPrefix}_PG_COMPONENT_PSQL_HOST`)
    const dbPassword = await components.config.requireString(`${dbPrefix}_PG_COMPONENT_PSQL_PASSWORD`)

    databaseUrl = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbDatabaseName}`
  }

  return createBasePgComponent(components, {
    ...rest,
    pool: {
      ...rest.pool,
      connectionString: databaseUrl
    }
  })
}
