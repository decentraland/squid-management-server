import { isErrorWithMessage } from '../../logic/errors'
import { HandlerContextWithPath, StatusCode } from '../../types'

// handlers arguments only type what they need, to make unit testing easier
export async function listSquidsHandler(context: Pick<HandlerContextWithPath<'squids', '/squids/list'>, 'components'>) {
  const {
    components: { squids }
  } = context

  const instances = await squids.list()

  return {
    status: StatusCode.OK,
    body: instances
  }
}

export async function stopSquidHandler(context: Pick<HandlerContextWithPath<'squids', '/squids/:id/stop'>, 'params' | 'components'>) {
  const {
    components: { squids },
    params: { id }
  } = context

  try {
    await squids.downgrade(id)
    return {
      status: StatusCode.OK
    }
  } catch (e) {
    console.error('error: ', e)
    return {
      status: StatusCode.BAD_REQUEST,
      body: {
        message: isErrorWithMessage(e) ? e.message : 'Could not stop the squid'
      }
    }
  }
}

// Restricts URL params that are interpolated into a SQL LIKE pattern.
// Allows lowercase letters, digits and hyphens only (Decentraland project + slot
// identifiers are e.g. "marketplace", "trades", "credits", "a", "b").
const SAFE_PARAM_RE = /^[a-z0-9-]+$/

export async function isLiveSquidHandler(
  context: Pick<HandlerContextWithPath<'squids', '/:project/:slot/is-live'>, 'params' | 'components'>
) {
  const {
    components: { squids },
    params: { project, slot }
  } = context

  if (!SAFE_PARAM_RE.test(project) || !SAFE_PARAM_RE.test(slot)) {
    return {
      status: StatusCode.BAD_REQUEST,
      body: {
        message: 'Invalid project or slot. Allowed: lowercase letters, digits, hyphen.'
      }
    }
  }

  try {
    const result = await squids.isLive(project, slot)
    return {
      status: StatusCode.OK,
      body: result
    }
  } catch (e) {
    console.error('error: ', e)
    return {
      status: StatusCode.BAD_REQUEST,
      body: {
        message: isErrorWithMessage(e) ? e.message : 'Could not determine live status'
      }
    }
  }
}

export async function promoteSquidHandler(context: Pick<HandlerContextWithPath<'squids', '/squids/:id/promote'>, 'params' | 'components'>) {
  const {
    components: { squids },
    params: { id }
  } = context

  try {
    await squids.promote(id)
    return {
      status: StatusCode.OK
    }
  } catch (e) {
    console.error('error: ', e)
    return {
      status: StatusCode.BAD_REQUEST,
      body: {
        message: isErrorWithMessage(e) ? e.message : 'Could not promote the squid'
      }
    }
  }
}
