import type {
  DriftPlugin,
  PluginManifest,
  PluginContext,
  Channel,
  OutgoingMessage,
} from '@drift/core'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

// ── Config Loader ────────────────────────────────────────

function readFeishuConfigFromFile(): FeishuPluginOptions {
  const dataDir = process.env.DRIFT_DATA_DIR || join(process.env.HOME || '/tmp', '.drift')
  const configPath = join(dataDir, 'config.json')
  if (!existsSync(configPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const feishu = raw?.channels?.feishu
    if (!feishu?.enabled) return {}
    return {
      webhookUrl: feishu.webhookUrl,
      secret: feishu.webhookSecret,
      wsConfig: feishu.appId && feishu.appSecret ? {
        appId: feishu.appId,
        appSecret: feishu.appSecret,
        allowFrom: feishu.allowFrom ?? [],
      } : undefined,
    }
  } catch { return {} }
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
export function createFeishuPlugin(options?: FeishuPluginOptions): DriftPlugin {
  // When loaded as external plugin (no args), read config from $DRIFT_DATA_DIR/config.json
  const opts: FeishuPluginOptions = options ?? readFeishuConfigFromFile()
  let wsClient: FeishuWsClient | null = null
  let savedCtx: PluginContext | null = null

  return {
    manifest: buildManifest(!!opts.wsConfig),

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
          if (!opts.webhookUrl) return  // WebSocket-only mode, no outbound webhook
          if (msg.type === 'card' && msg.metadata?.card) {
            await sendFeishuWebhook(
              opts.webhookUrl,
              msg.metadata.card as { msg_type: 'interactive'; card: Record<string, unknown> },
              opts.secret,
            )
          } else {
            await sendFeishuText(opts.webhookUrl, msg.content, opts.secret)
          }
        },
      }

      ctx.channels.register(feishuChannel)
      ctx.logger.info('Feishu channel registered')
    },

    async start() {
      if (!opts.wsConfig || !savedCtx) return

      const ctx = savedCtx
      const db = getStorageDb(ctx)
      const chatHandle = getChatHandle(ctx)

      wsClient = new FeishuWsClient(opts.wsConfig, {
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
