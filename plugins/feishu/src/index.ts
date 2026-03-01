import type {
  DriftPlugin,
  PluginContext,
  Channel,
  OutgoingMessage,
} from '@drift/core'
import type Database from 'better-sqlite3'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

// ── Context helpers ──────────────────────────────────────

type AnyCtx = PluginContext & Record<string, unknown>

function registerChannelCapability(ctx: AnyCtx, capabilityName: string, ch: Channel): void {
  if (typeof ctx['register'] === 'function') {
    ;(ctx['register'] as (n: string, h: () => unknown) => void)(capabilityName, () => ch)
  } else if (ctx['channels'] && typeof (ctx['channels'] as Record<string, unknown>)['register'] === 'function') {
    ;((ctx['channels'] as Record<string, unknown>)['register'] as (ch: Channel) => void)(ch)
  }
}

async function getDb(ctx: AnyCtx): Promise<Database.Database> {
  if (typeof ctx['call'] === 'function') {
    return (ctx['call'] as <T>(cap: string) => Promise<T>)<Database.Database>('sqlite.db')
  }
  const atoms = ctx['atoms'] as { atom<T>(k: string, d: T): { deref(): T } } | undefined
  const db = atoms?.atom<Database.Database | null>('storage.db', null)?.deref()
  if (!db) throw new Error('Storage plugin not initialized')
  return db
}

async function getChatHandleFn(ctx: AnyCtx): Promise<(msg: InboundMessage) => AsyncIterable<ChatEvent>> {
  if (typeof ctx['call'] === 'function') {
    return (ctx['call'] as <T>(cap: string) => Promise<T>)<(msg: InboundMessage) => AsyncIterable<ChatEvent>>('chat.handle')
  }
  const atoms = ctx['atoms'] as { atom<T>(k: string, d: T): { deref(): T } } | undefined
  const fn = atoms?.atom<((msg: InboundMessage) => AsyncIterable<ChatEvent>) | null>('chat.handle', null)?.deref()
  if (!fn) throw new Error('Chat plugin not initialized')
  return fn
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the Feishu plugin.
 *
 * Registers itself as a Channel capability (`channel.feishu`) so other plugins
 * can discover it via `ctx.call('channel.feishu')`. Falls back to the old
 * `ctx.channels.register()` API for backward compatibility.
 *
 * If `wsConfig` is provided, also starts a WSClient long-poll connection
 * during the `start()` phase to receive incoming Feishu messages and
 * route them through the chat pipeline.
 */
export function createFeishuPlugin(options?: FeishuPluginOptions): DriftPlugin {
  // When loaded as external plugin (no args), read config from $DRIFT_DATA_DIR/config.json
  const opts: FeishuPluginOptions = options ?? readFeishuConfigFromFile()
  let wsClient: FeishuWsClient | null = null
  let sendQueue: WebhookSendQueue | null = null
  let savedCtx: AnyCtx | null = null

  return {
    name: 'feishu',
    manifest: {
      name: 'feishu',
      version: '1.0.0',
      type: 'code',
      capabilities: {
        events: { listen: ['chat.complete', 'cron.chat'] },
        network: true,
      },
      depends: opts.wsConfig ? ['chat', 'channel', 'storage'] : [],
    },

    async init(ctx: PluginContext) {
      savedCtx = ctx as AnyCtx
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

      registerChannelCapability(ctx as AnyCtx, 'channel.feishu', feishuChannel)
      ctx.logger.info('Feishu channel registered (rate-limited send queue enabled)')
    },

    async start() {
      if (!opts.wsConfig || !savedCtx) return

      const ctx = savedCtx
      const db = await getDb(ctx)
      const chatHandle = await getChatHandleFn(ctx)

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
  } as DriftPlugin
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
