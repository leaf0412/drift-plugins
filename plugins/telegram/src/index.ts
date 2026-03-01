// plugins/telegram/src/index.ts

import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Channel, OutgoingMessage } from '@drift/core'
import type { Context, Hono } from 'hono'
import type Database from 'better-sqlite3'
import { deleteSession, deleteSessionsByPrefix } from '@drift/plugins'
import type { InboundMessage, ChatEvent } from '@drift/plugins'
import { TelegramBot } from './bot.js'
import { TelegramApi } from './api.js'
import { TelegramSendQueue } from './send-queue.js'
import { truncate } from './html.js'
import type { TelegramUpdate } from './api.js'

// ── Options ───────────────────────────────────────────────

export interface TelegramPluginOptions {
  botToken?: string
  chatId?: string | number
  allowFrom?: number[]
  webhookUrl?: string
  webhookSecret?: string
}

// ── Plugin Factory ────────────────────────────────────────

export function createTelegramPlugin(options?: TelegramPluginOptions): DriftPlugin {
  let bot: TelegramBot | null = null
  let sendQueue: TelegramSendQueue | null = null
  let savedCtx: PluginContext | null = null
  // Resolved config: constructor options override, else read from ctx.config in init()
  let opts: TelegramPluginOptions = options ?? {}

  return {
    name: 'telegram',
    version: '1.1.0',

    configSchema: {
      botToken:      { type: 'string', description: 'Telegram Bot Token', secret: true, required: true },
      chatId:        { type: 'string', description: 'Telegram Chat ID' },
      allowFrom:     { type: 'string[]', description: '允许的 Telegram user ID 列表' },
      webhookUrl:    { type: 'string', description: 'Webhook URL (留空则用 polling)' },
      webhookSecret: { type: 'string', description: 'Webhook Secret', secret: true },
    },
    requiresCapabilities: ['chat.handle'],

    async init(ctx: PluginContext) {
      savedCtx = ctx

      // If no constructor options were provided, read from per-plugin config
      if (!options) {
        const botToken = ctx.config.get<string>('botToken')
        const chatId = ctx.config.get<string>('chatId')
        const allowFromStr = ctx.config.get<string[]>('allowFrom', [])
        const webhookUrl = ctx.config.get<string>('webhookUrl')
        const webhookSecret = ctx.config.get<string>('webhookSecret')

        opts = {
          botToken,
          chatId,
          allowFrom: allowFromStr.map(Number),
          webhookUrl,
          webhookSecret,
        }
      }

      if (!opts.botToken) {
        ctx.logger.warn('Telegram plugin: no botToken configured, skipping')
        return
      }

      const api = new TelegramApi(opts.botToken)
      sendQueue = new TelegramSendQueue(ctx.logger)

      const queue = sendQueue
      const notifyChatId = opts.chatId

      // Register Channel capability for notify broadcasts (outbound only)
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

      ctx.register('channel.telegram', () => telegramChannel)
      ctx.logger.info('Telegram channel registered (rate-limited send queue enabled)')
    },

    async start() {
      if (!opts.botToken || !savedCtx) return

      const ctx = savedCtx
      const db = await ctx.call<Database.Database>('sqlite.db')
      const chatHandle = await ctx.call<(msg: InboundMessage) => AsyncIterable<ChatEvent>>('chat.handle')

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
        const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })
        app.post('/api/telegram/webhook', async (c: Context) => {
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
