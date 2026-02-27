// plugins/telegram/src/index.ts

import type {
  DriftPlugin,
  PluginManifest,
  PluginContext,
  Channel,
  OutgoingMessage,
} from '@drift/core'
import type { Context } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getStorageDb, getChatHandle, deleteSession, deleteSessionsByPrefix } from '@drift/plugins'
import { TelegramBot } from './bot.js'
import { TelegramApi } from './api.js'
import { TelegramSendQueue } from './send-queue.js'
import { truncate } from './html.js'
import type { TelegramUpdate } from './api.js'

// ── Manifest ──────────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'telegram',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    events: { listen: ['chat.complete', 'cron.chat'] },
    network: true,
  },
  depends: ['chat', 'channel', 'storage'],
}

// ── Options ───────────────────────────────────────────────

export interface TelegramPluginOptions {
  botToken?: string
  chatId?: string | number
  allowFrom?: number[]
  webhookUrl?: string
  webhookSecret?: string
}

// ── Config Loader ─────────────────────────────────────────

function readTelegramConfigFromFile(): TelegramPluginOptions {
  const dataDir = process.env.DRIFT_DATA_DIR || join(process.env.HOME || '/tmp', '.drift')
  const configPath = join(dataDir, 'config.json')
  if (!existsSync(configPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const tg = raw?.channels?.telegram
    if (!tg?.enabled) return {}
    return {
      botToken: tg.botToken,
      chatId: tg.chatId,
      allowFrom: tg.allowFrom ?? [],
      webhookUrl: tg.webhookUrl,
      webhookSecret: tg.webhookSecret,
    }
  } catch { return {} }
}

// ── Plugin Factory ────────────────────────────────────────

export function createTelegramPlugin(options?: TelegramPluginOptions): DriftPlugin {
  const opts: TelegramPluginOptions = options ?? readTelegramConfigFromFile()
  let bot: TelegramBot | null = null
  let sendQueue: TelegramSendQueue | null = null
  let savedCtx: PluginContext | null = null

  return {
    manifest,

    async init(ctx: PluginContext) {
      savedCtx = ctx

      if (!opts.botToken) {
        ctx.logger.warn('Telegram plugin: no botToken configured, skipping')
        return
      }

      const api = new TelegramApi(opts.botToken)
      sendQueue = new TelegramSendQueue(ctx.logger)

      const queue = sendQueue
      const notifyChatId = opts.chatId

      // Register Channel for notify broadcasts (outbound only)
      // notify plugin sends { type: 'text', content: formattedText, metadata: { event } }
      // content is already pre-formatted by notify, so we use it directly
      const telegramChannel: Channel = {
        name: 'telegram',
        capabilities: {
          streaming: false,
          richContent: false,
          fileUpload: false,
          interactive: false,
        },

        async send(msg: OutgoingMessage) {
          if (!notifyChatId) return
          const text = truncate(msg.content)
          queue.enqueue(() => api.sendMessage(notifyChatId, text).then(() => {}))
        },
      }

      ctx.channels.register(telegramChannel)
      ctx.logger.info('Telegram channel registered (rate-limited send queue enabled)')
    },

    async start() {
      if (!opts.botToken || !savedCtx) return

      const ctx = savedCtx
      const db = getStorageDb(ctx)
      const chatHandle = getChatHandle(ctx)

      bot = new TelegramBot(
        {
          botToken: opts.botToken,
          allowFrom: opts.allowFrom,
        },
        {
          chatHandle,
          deleteSession: (sessionId: string) => deleteSession(db, sessionId),
          deleteSessionsByPrefix: (prefix: string) => deleteSessionsByPrefix(db, prefix),
          logger: ctx.logger,
        },
      )

      // Register bot commands
      await bot.telegramApi.setMyCommands([
        { command: 'clear', description: 'Clear conversation context' },
        { command: 'start', description: 'Start the bot' },
      ]).catch(err => ctx.logger.warn('Telegram: failed to set commands', err))

      if (opts.webhookUrl) {
        // Webhook mode
        await bot.telegramApi.setWebhook(opts.webhookUrl, opts.webhookSecret)
          .catch(err => ctx.logger.error('Telegram: failed to set webhook', err))

        const secret = opts.webhookSecret
        ctx.routes.post('/api/telegram/webhook', async (c: Context) => {
          if (secret) {
            const headerSecret = c.req.header('x-telegram-bot-api-secret-token')
            if (headerSecret !== secret) {
              return c.json({ error: 'unauthorized' }, 403)
            }
          }
          const update = await c.req.json<TelegramUpdate>()
          bot?.handleWebhookUpdate(update).catch(err => {
            ctx.logger.error('Telegram webhook handler error', err)
          })
          return c.json({ ok: true })
        })
        ctx.logger.info(`Telegram bot: webhook mode (${opts.webhookUrl})`)
      } else {
        // Polling mode
        bot.startPolling().catch(err => {
          ctx.logger.error('Telegram bot: polling loop exited', err)
        })
      }
    },

    async stop() {
      if (sendQueue) {
        sendQueue.stop()
        sendQueue = null
      }
      if (bot) {
        if (opts.webhookUrl) {
          await bot.telegramApi.deleteWebhook().catch(() => {})
        }
        bot.stop()
        bot = null
      }
    },
  }
}

export default createTelegramPlugin

// ── Re-exports ────────────────────────────────────────────

export { TelegramApi, TelegramApiError } from './api.js'
export type { TelegramMessage, TelegramUpdate, TelegramChat, TelegramUser } from './api.js'
export { TelegramBot } from './bot.js'
export type { TelegramBotConfig, TelegramBotDeps } from './bot.js'
export { TelegramSendQueue } from './send-queue.js'
export type { SendQueueOptions, SendQueueLogger } from './send-queue.js'
export { escapeHtml, truncate, splitMessage } from './html.js'
