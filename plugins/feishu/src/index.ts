import type {
  DriftPlugin,
  PluginManifest,
  PluginContext,
  Channel,
  OutgoingMessage,
} from '@drift/core'
import { sendFeishuWebhook, sendFeishuText } from './webhook.js'
import { FeishuWsClient } from './ws-client.js'
import type { FeishuWsConfig } from './ws-client.js'
import { getStorageDb, getChatHandle, deleteSession, deleteSessionsByPrefix } from '@drift/plugins'

// ── Manifest ──────────────────────────────────────────────

function buildManifest(hasWs: boolean): PluginManifest {
  return {
    name: 'feishu',
    version: '1.0.0',
    type: 'code',
    capabilities: {
      events: { listen: ['chat.complete', 'cron.chat'] },
      network: true,
    },
    depends: hasWs ? ['chat', 'channel', 'storage'] : [],
  }
}

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
 * Registers itself as a Channel so plugin-notify can broadcast to it
 * (outbound webhook messages).
 *
 * If `wsConfig` is provided, also starts a WSClient long-poll connection
 * during the `start()` phase to receive incoming Feishu messages and
 * route them through the chat pipeline.
 */
export function createFeishuPlugin(options: FeishuPluginOptions): DriftPlugin {
  let wsClient: FeishuWsClient | null = null
  let savedCtx: PluginContext | null = null

  return {
    manifest: buildManifest(!!options.wsConfig),

    async init(ctx: PluginContext) {
      savedCtx = ctx

      const feishuChannel: Channel = {
        name: 'feishu',
        capabilities: {
          streaming: false,
          richContent: true,
          fileUpload: false,
          interactive: false,
        },

        async send(msg: OutgoingMessage) {
          if (!options.webhookUrl) return  // WebSocket-only mode, no outbound webhook
          if (msg.type === 'card' && msg.metadata?.card) {
            await sendFeishuWebhook(
              options.webhookUrl,
              msg.metadata.card as { msg_type: 'interactive'; card: Record<string, unknown> },
              options.secret,
            )
          } else {
            await sendFeishuText(options.webhookUrl, msg.content, options.secret)
          }
        },
      }

      ctx.channels.register(feishuChannel)
      ctx.logger.info('Feishu channel registered')
    },

    async start() {
      if (!options.wsConfig || !savedCtx) return

      const ctx = savedCtx
      const db = getStorageDb(ctx)
      const chatHandle = getChatHandle(ctx)

      wsClient = new FeishuWsClient(options.wsConfig, {
        chatHandle,
        deleteSession: (sessionId: string) => deleteSession(db, sessionId),
        deleteSessionsByPrefix: (prefix: string) => deleteSessionsByPrefix(db, prefix),
        logger: ctx.logger,
      })

      wsClient.start()
    },

    async stop() {
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
