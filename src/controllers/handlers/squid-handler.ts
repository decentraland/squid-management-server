import { HandlerContextWithPath } from '../../types'

// handlers arguments only type what they need, to make unit testing easier
export async function squidsHandler(context: Pick<HandlerContextWithPath<'squids', '/squids/list'>, 'url' | 'components'>) {
  const {
    components: { squids }
  } = context

  const instances = await squids.list()

  return {
    body: instances
  }
}
