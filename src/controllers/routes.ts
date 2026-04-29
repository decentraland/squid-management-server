import { Router } from '@dcl/http-server'
import { GlobalContext } from '../types'
import { isLiveSquidHandler, listSquidsHandler, promoteSquidHandler, stopSquidHandler } from './handlers/squid-handler'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  router.get('/list', listSquidsHandler)
  router.get('/:project/:slot/is-live', isLiveSquidHandler)
  router.put('/:id/promote', promoteSquidHandler)
  router.put('/:id/stop', stopSquidHandler)

  return router
}
