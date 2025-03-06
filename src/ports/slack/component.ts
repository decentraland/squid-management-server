import { App } from '@slack/bolt'
import { IBaseComponent, IConfigComponent } from '@well-known-components/interfaces'

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

export async function createSlackComponent({ config }: { config: IConfigComponent }): Promise<ISlackComponent> {
  const token = await config.requireString('SLACK_BOT_TOKEN')
  const signingSecret = await config.requireString('SLACK_SIGNING_SECRET')
  const defaultChannel = (await config.getString('SLACK_CHANNEL')) || 'general'

  // Initialize the Bolt application
  const app = new App({
    token,
    // Configuration to use HTTP instead of Socket Mode
    // since we only need to send messages, not receive events
    appToken: undefined,
    signingSecret
  })

  let isStarted = false
  let isStarting = false

  async function start() {
    if (isStarted || isStarting) return
    isStarting = true

    try {
      // We don't need to start an HTTP server since we'll only use
      // the Slack API to send messages
      isStarted = true
      console.log('Slack component initialized')
    } catch (error) {
      console.error('Error starting Slack component:', error)
      isStarting = false
      throw error
    }

    isStarting = false
  }

  async function stop() {
    if (!isStarted) return
    isStarted = false
    console.log('Slack component stopped')
  }

  async function sendMessage(text: string, channel: string = defaultChannel): Promise<void> {
    try {
      if (!isStarted) await start()

      // Use the Bolt client to send a simple message
      await app.client.chat.postMessage({
        channel,
        text
      })
    } catch (error: unknown) {
      console.error('Error sending message to Slack:', error)
    }
  }

  async function sendFormattedMessage(message: SlackMessage, channel: string = defaultChannel): Promise<void> {
    try {
      if (!isStarted) await start()

      // Use the Bolt client to send a formatted message
      await app.client.chat.postMessage({
        channel,
        text: message.text,
        blocks: message.blocks
      })
    } catch (error: unknown) {
      console.error('Error sending formatted message to Slack:', error)
    }
  }

  return {
    start,
    stop,
    sendMessage,
    sendFormattedMessage
  }
}
