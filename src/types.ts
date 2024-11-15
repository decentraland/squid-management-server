import type { IFetchComponent } from '@well-known-components/http-server'
import type {
  IConfigComponent,
  ILoggerComponent,
  IHttpServerComponent,
  IBaseComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import { IPgComponent } from '@well-known-components/pg-component'
import { metricDeclarations } from './metrics'
import { ISquidComponent } from './ports/squids/types'

export type GlobalContext = {
  components: BaseComponents
}

// components used in every environment
export type BaseComponents = {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  fetch: IFetchComponent
  dappsDatabase: IPgComponent
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  squids: ISquidComponent
}

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<ComponentNames extends keyof AppComponents, Path extends string> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>

export type Context<Path extends string> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>

export enum StatusCode {
  OK = 200,
  CREATED = 201,
  UPDATED = 204,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  LOCKED = 423,
  CONFLICT = 409,
  ERROR = 500,
  UNPROCESSABLE_CONTENT = 422
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuthenticatedContext<Path extends string = any> = Context<Path>

export type PaginatedResponse<T> = {
  results: T[]
  total: number
  page: number
  pages: number
  limit: number
}

export type HTTPErrorResponseBody<T> = {
  ok: false
  message: string
  data?: T
}

export type HTTPSuccessResponseBody<T> = {
  ok: true
  data: T
}

export type HTTPResponseBody<T> = HTTPErrorResponseBody<T> | HTTPSuccessResponseBody<T>

export type HTTPResponse<T> = {
  status: StatusCode
  body:
    | {
        ok: false
        message: string
        data?: object
      }
    | {
        ok: true
        data?: PaginatedResponse<T>
      }
    | {
        ok: true
        data?: T
      }
}
