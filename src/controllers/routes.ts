import { Router } from '@well-known-components/http-server'
import { GlobalContext } from '../types'
import { squidsHandler } from './handlers/squid-handler'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  router.get('/list', squidsHandler)

  return router
}
