import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Channel, OutgoingMessage } from '@drift/core'
import type Database from 'better-sqlite3'
import { sendFeishuWebhook, sendFeishuText } from './webhook.js'
import { FeishuWsClient } from './ws-client.js'
import { WebhookSendQueue } from './send-queue.js'
import type { FeishuWsConfig } from './ws-client.js'
import { deleteSession, deleteSessionsByPrefix } from '@drift/plugins'
import type { InboundMessage, ChatEvent } from '@drift/plugins'

// ── Options ───────────────────────────────────────────────

export interface FeishuPluginOptions {
  webhookUrl?: string
  secret?: string
  /** If provided, starts a WSClient long-poll connection for incoming messages */
  wsConfig?: FeishuWsConfig
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the Feishu plugin.
 *
 * Registers itself as a Channel capability (`channel.feishu`) so other plugins
 * can discover it via `ctx.call('channel.feishu')`.
 *
 * If `wsConfig` is provided, also starts a WSClient long-poll connection
 * during the `start()` phase to receive incoming Feishu messages and
 * route them through the chat pipeline.
 */
export function createFeishuPlugin(options?: FeishuPluginOptions): DriftPlugin {
  let wsClient: FeishuWsClient | null = null
  let sendQueue: WebhookSendQueue | null = null
  let savedCtx: PluginContext | null = null
  // Resolved config: constructor options override, else read from ctx.config in init()
  let opts: FeishuPluginOptions = options ?? {}

  return {
    name: 'feishu',

    configSchema: {
      appId:         { type: 'string', description: '飞书 App ID' },
      appSecret:     { type: 'string', description: '飞书 App Secret', secret: true },
      webhookUrl:    { type: 'string', description: '飞书 Webhook URL (出站消息)' },
      webhookSecret: { type: 'string', description: '飞书 Webhook 签名密钥', secret: true },
      allowFrom:     { type: 'string[]', description: '允许的发送者 open_id 列表' },
    },
    requiresCapabilities: ['chat.handle'],

    async init(ctx: PluginContext) {
      savedCtx = ctx

      // If no constructor options were provided, read from per-plugin config
      if (!options) {
        const appId = ctx.config.get<string>('appId')
        const appSecret = ctx.config.get<string>('appSecret')
        const webhookUrl = ctx.config.get<string>('webhookUrl')
        const webhookSecret = ctx.config.get<string>('webhookSecret')
        const allowFrom = ctx.config.get<string[]>('allowFrom', [])

        opts = {
          webhookUrl,
          secret: webhookSecret,
          wsConfig: appId && appSecret ? { appId, appSecret, allowFrom } : undefined,
        }
      }

      sendQueue = new WebhookSendQueue(ctx.logger)

      const queue = sendQueue
      const feishuChannel: Channel = {
        name: 'feishu',
        capabilities: {
          streaming: false,
          richContent: true,
          fileUpload: false,
          interactive: false,
        },

        async send(msg: OutgoingMessage) {
          if (!opts.webhookUrl) return  // WebSocket-only mode, no outbound webhook
          const url = opts.webhookUrl
          const secret = opts.secret

          if (msg.type === 'card' && msg.metadata?.card) {
            queue.enqueue(() =>
              sendFeishuWebhook(
                url,
                msg.metadata!.card as { msg_type: 'interactive'; card: Record<string, unknown> },
                secret,
              ),
            )
          } else {
            queue.enqueue(() => sendFeishuText(url, msg.content, secret))
          }
        },
      }

      ctx.register('channel.feishu', () => feishuChannel)
      ctx.logger.info('Feishu channel registered (rate-limited send queue enabled)')
    },

    async start() {
      if (!opts.wsConfig || !savedCtx) return

      const ctx = savedCtx
      const db = await ctx.call<Database.Database>('sqlite.db')
      const chatHandle = await ctx.call<(msg: InboundMessage) => AsyncIterable<ChatEvent>>('chat.handle')

      wsClient = new FeishuWsClient(opts.wsConfig, {
        chatHandle,
        deleteSession: (sessionId: string) => deleteSession(db, sessionId),
        deleteSessionsByPrefix: (prefix: string) => deleteSessionsByPrefix(db, prefix),
        logger: ctx.logger,
      })

      wsClient.start()
    },

    async stop() {
      if (sendQueue) {
        sendQueue.stop()
        sendQueue = null
      }
      if (wsClient) {
        wsClient.stop()
        wsClient = null
      }
    },
  }
}

// ── Re-exports ────────────────────────────────────────────

export {
  sendFeishuWebhook,
  sendFeishuText,
  generateSign,
  formatChatCompleteCard,
  formatTestCard,
  formatTaskReminderCard,
  formatCronResultCard,
  formatCronNotifyCard,
  formatCronChatCard,
  formatGenericCard,
} from './webhook.js'
export type { FeishuMessage } from './webhook.js'
export { FeishuWsClient } from './ws-client.js'
export type { FeishuWsConfig, FeishuWsDeps, ChatHandleFn as FeishuChatHandleFn } from './ws-client.js'
export { WebhookSendQueue } from './send-queue.js'
export type { SendQueueOptions, SendQueueLogger } from './send-queue.js'
