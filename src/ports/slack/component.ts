import { IBaseComponent, IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createSlackComponent as createBaseSlackComponent } from '@dcl/slack-component'

export type SlackMessageBlock = {
  type: 'section' | 'header' | 'divider' | 'context'
  text?: {
    type: 'mrkdwn' | 'plain_text'
    text: string
  }
  fields?: Array<{
    type: 'mrkdwn' | 'plain_text'
    text: string
  }>
  elements?: Array<{
    type: 'mrkdwn' | 'plain_text'
    text: string
  }>
  accessory?: {
    type: 'button'
    text: {
      type: 'plain_text'
      text: string
    }
    action_id: string
  }
}

export type SlackMessage = {
  blocks?: SlackMessageBlock[]
  text: string
}

export type ISlackComponent = IBaseComponent & {
  sendFormattedMessage(message: SlackMessage, channel?: string): Promise<void>
}

export async function createSlackComponent({
  config,
  logs
}: {
  config: IConfigComponent
  logs: ILoggerComponent
}): Promise<ISlackComponent> {
  const token = await config.requireString('SLACK_BOT_TOKEN')
  const defaultChannel = (await config.getString('SLACK_CHANNEL')) || 'general'
  const slack = createBaseSlackComponent({ logs }, { token })

  async function sendFormattedMessage(message: SlackMessage, channel: string = defaultChannel): Promise<void> {
    await slack.sendMessage({
      channel,
      text: message.text,
      blocks: message.blocks
    })
  }

  return {
    sendFormattedMessage
  }
}
