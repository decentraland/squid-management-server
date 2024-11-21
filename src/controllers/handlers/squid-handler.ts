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
    return {
      status: StatusCode.BAD_REQUEST,
      body: {
        message: isErrorWithMessage(e) ? e.message : 'Could not stop squid'
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
    return {
      status: StatusCode.BAD_REQUEST,
      body: {
        message: isErrorWithMessage(e) ? e.message : 'Could not promote squid'
      }
    }
  }
}
