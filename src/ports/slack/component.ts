import { App } from '@slack/bolt'
import { IBaseComponent, IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'

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
  sendMessage(text: string, channel?: string): Promise<void>
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
  const signingSecret = await config.requireString('SLACK_SIGNING_SECRET')
  const defaultChannel = (await config.getString('SLACK_CHANNEL')) || 'general'
  const logger = logs.getLogger('slack-component')

  // Initialize the Bolt application
  const app = new App({
    token,
    // Configuration to use HTTP instead of Socket Mode
    // since we only need to send messages, not receive events
    appToken: undefined,
    signingSecret
  })

  // Simple implementation of start/stop to satisfy IBaseComponent interface
  async function start() {
    logger.info('Slack component initialized')
    return
  }

  async function stop() {
    logger.info('Slack component stopped')
    await app.stop()
    return
  }

  async function sendMessage(text: string, channel: string = defaultChannel): Promise<void> {
    try {
      // Use the Bolt client to send a simple message
      await app.client.chat.postMessage({
        channel,
        text
      })
    } catch (error: unknown) {
      logger.error('Error sending message to Slack:', { error: String(error) })
    }
  }

  async function sendFormattedMessage(message: SlackMessage, channel: string = defaultChannel): Promise<void> {
    try {
      // Use the Bolt client to send a formatted message
      await app.client.chat.postMessage({
        channel,
        text: message.text,
        blocks: message.blocks
      })
    } catch (error: unknown) {
      logger.error('Error sending formatted message to Slack:', { error: String(error) })
    }
  }

  return {
    start,
    stop,
    sendMessage,
    sendFormattedMessage
  }
}
