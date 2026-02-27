// plugins/telegram/src/bot.ts

import { homedir } from 'node:os'
import { TelegramApi, TelegramApiError } from './api.js'
import type { TelegramUpdate } from './api.js'
import { truncate, splitMessage } from './html.js'

// ── Types (from @drift/plugins, redeclared minimally for decoupling) ──

// These match the types from @drift/plugins but are declared here to avoid
// import issues when the plugin is loaded by jiti at runtime.
// The chatHandle function is injected via deps, so structural typing ensures compatibility.

export interface TelegramBotConfig {
  botToken: string
  allowFrom?: number[]
}

interface ChatEvent {
  type: string
  content?: string
  toolCall?: Record<string, unknown>
  response?: Record<string, unknown>
  error?: string
}

export interface TelegramBotDeps {
  chatHandle: (msg: InboundMessage) => AsyncIterable<ChatEvent>
  deleteSession: (sessionId: string) => boolean
  deleteSessionsByPrefix: (prefix: string) => number
  logger: BotLogger
}

interface BotLogger {
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
  debug: (msg: string, ...args: unknown[]) => void
}

interface InboundMessage {
  channelId: string
  sessionId: string
  content: string
  metadata?: Record<string, unknown>
}

// ── Constants ──────────────────────────────────────────────

const POLL_TIMEOUT = 30
const DRAFT_UPDATE_INTERVAL_MS = 1000
const EDIT_UPDATE_INTERVAL_MS = 1500
const DEDUP_TTL_MS = 5 * 60 * 1000

// ── Bot ────────────────────────────────────────────────────

export class TelegramBot {
  private api: TelegramApi
  private config: TelegramBotConfig
  private deps: TelegramBotDeps
  private running = false
  private offset = 0
  private startedAt = 0
  private processedUpdates = new Map<number, number>()
  /** Track whether sendMessageDraft is supported (may not be on older Bot API) */
  private draftSupported = true

  constructor(config: TelegramBotConfig, deps: TelegramBotDeps) {
    this.config = config
    this.deps = deps
    this.api = new TelegramApi(config.botToken)
  }

  get telegramApi(): TelegramApi {
    return this.api
  }

  // ── Polling lifecycle ─────────────────────────────────────

  async startPolling(): Promise<void> {
    this.running = true
    this.startedAt = Date.now()
    this.deps.logger.info('Telegram bot: polling started')

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(
          this.offset || undefined,
          POLL_TIMEOUT,
          ['message'],
        )

        for (const update of updates) {
          this.offset = update.update_id + 1
          this.handleUpdate(update).catch(err => {
            this.deps.logger.error('Telegram bot: update handler error', err)
          })
        }
      } catch (err) {
        if (!this.running) break
        if (err instanceof TelegramApiError && err.retryAfter) {
          this.deps.logger.warn(`Telegram bot: rate limited, waiting ${err.retryAfter}s`)
          await sleep(err.retryAfter * 1000)
        } else {
          this.deps.logger.error('Telegram bot: polling error', err)
          await sleep(3000)
        }
      }
    }
  }

  stop(): void {
    this.running = false
    this.processedUpdates.clear()
    this.deps.logger.info('Telegram bot: stopped')
  }

  // ── Webhook entry point ───────────────────────────────────

  async handleWebhookUpdate(update: TelegramUpdate): Promise<void> {
    await this.handleUpdate(update)
  }

  // ── Update processing ─────────────────────────────────────

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message
    if (!msg?.text || !msg.from) return

    // Dedup
    if (this.processedUpdates.has(update.update_id)) return
    this.processedUpdates.set(update.update_id, Date.now())
    this.pruneProcessedUpdates()

    // Reject stale messages (replayed on restart)
    const msgTimestamp = msg.date * 1000
    if (this.startedAt > 0 && msgTimestamp < this.startedAt) {
      this.deps.logger.debug(`Telegram bot: skipped stale message ${update.update_id}`)
      return
    }

    const userId = msg.from.id
    const chatId = msg.chat.id
    const chatType = msg.chat.type
    const text = msg.text.trim()

    // Allowlist check
    const allowFrom = this.config.allowFrom ?? []
    if (allowFrom.length > 0 && !allowFrom.includes(userId)) {
      this.deps.logger.debug(`Telegram bot: ignored message from ${userId} (not in allowFrom)`)
      return
    }

    // /clear command
    if (text === '/clear') {
      const prefix = `telegram:${userId}:`
      const count = this.deps.deleteSessionsByPrefix(prefix)
      await this.api.sendMessage(chatId, '上下文已清除 ✨')
      this.deps.logger.info(`Telegram bot: cleared ${count} session(s) for user ${userId}`)
      return
    }

    // /start command
    if (text === '/start') {
      await this.api.sendMessage(chatId, 'Drift bot ready. Send a message to begin.')
      return
    }

    this.deps.logger.info(`Telegram bot: received from ${userId}: ${text.slice(0, 80)}`)

    // sessionId is empty — chatHandle resolves it from channelId + metadata.userId
    const inbound: InboundMessage = {
      channelId: 'telegram',
      sessionId: '',
      content: text,
      metadata: { userId: String(userId), cwd: homedir() },
    }

    try {
      if (chatType === 'private') {
        await this.handlePrivateChat(chatId, inbound)
      } else {
        await this.handleGroupChat(chatId, inbound)
      }
    } catch (err) {
      this.deps.logger.error('Telegram bot: chat error', err)
      await this.api.sendMessage(chatId, '处理消息时出错，请稍后重试').catch(() => {})
    }
  }

  // ── Private chat: sendMessageDraft with editMessageText fallback ──

  private async handlePrivateChat(
    chatId: number,
    inbound: InboundMessage,
  ): Promise<void> {
    if (this.draftSupported) {
      try {
        await this.handlePrivateDraft(chatId, inbound)
        return
      } catch (err) {
        // If sendMessageDraft fails (unsupported API), fall back permanently.
        // Note: this wastes one LLM request (the chatHandle iterator is abandoned).
        // Acceptable because this detection only happens once per bot lifetime.
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Not Found') || msg.includes('method not found')) {
          this.deps.logger.warn('Telegram bot: sendMessageDraft not supported, falling back to editMessageText')
          this.draftSupported = false
        } else {
          throw err
        }
      }
    }

    await this.handlePrivateEdit(chatId, inbound)
  }

  /** Primary: sendMessageDraft streaming */
  private async handlePrivateDraft(
    chatId: number,
    inbound: InboundMessage,
  ): Promise<void> {
    const draftId = `${chatId}-${Date.now()}`
    let accumulated = ''
    let lastDraftAt = 0
    let firstDraft = true

    for await (const event of this.deps.chatHandle(inbound)) {
      const now = Date.now()

      if (event.type === 'delta' && event.content) {
        accumulated += event.content

        if (now - lastDraftAt >= DRAFT_UPDATE_INTERVAL_MS) {
          lastDraftAt = now
          const draftText = truncate(accumulated)
          if (firstDraft) {
            // First draft call — if it throws "not found", caller catches and disables draft mode
            await this.api.sendMessageDraft(chatId, draftId, draftText)
            firstDraft = false
          } else {
            await this.api.sendMessageDraft(chatId, draftId, draftText).catch(() => {})
          }
        }
      } else if (event.type === 'tool_start') {
        const toolName = event.toolCall?.name || 'tool'
        const draftText = truncate((accumulated || '思考中…') + `\n\n⏳ ${toolName}...`)
        if (firstDraft) {
          // First draft call — if it throws "not found", caller catches and disables draft mode
          await this.api.sendMessageDraft(chatId, draftId, draftText)
          firstDraft = false
        } else {
          await this.api.sendMessageDraft(chatId, draftId, draftText).catch(() => {})
        }
        lastDraftAt = now
      }
    }

    // Finalize: commit the draft with sendMessage (split if needed)
    const finalText = accumulated || '(empty response)'
    const chunks = splitMessage(finalText)
    for (const chunk of chunks) {
      await this.api.sendMessage(chatId, chunk)
    }
  }

  /** Fallback: editMessageText streaming (if sendMessageDraft not available) */
  private async handlePrivateEdit(
    chatId: number,
    inbound: InboundMessage,
  ): Promise<void> {
    const placeholder = await this.api.sendMessage(chatId, '思考中…')
    const messageId = placeholder.message_id
    let accumulated = ''
    let lastEditAt = 0
    let lastEditedText = ''

    for await (const event of this.deps.chatHandle(inbound)) {
      const now = Date.now()

      if (event.type === 'delta' && event.content) {
        accumulated += event.content

        if (now - lastEditAt >= EDIT_UPDATE_INTERVAL_MS) {
          const editText = truncate(accumulated + ' ▍')
          if (editText !== lastEditedText) {
            lastEditAt = now
            lastEditedText = editText
            await this.api.editMessageText(chatId, messageId, editText).catch(() => {})
          }
        }
      } else if (event.type === 'tool_start') {
        const toolName = event.toolCall?.name || 'tool'
        const editText = truncate((accumulated || '思考中…') + `\n\n⏳ ${toolName}...`)
        if (editText !== lastEditedText) {
          lastEditAt = now
          lastEditedText = editText
          await this.api.editMessageText(chatId, messageId, editText).catch(() => {})
        }
      }
    }

    // Final update — use splitMessage to avoid misleading "(truncated)" label
    const finalText = accumulated || '(empty response)'
    const chunks = splitMessage(finalText)
    if (chunks[0] !== lastEditedText) {
      await this.api.editMessageText(chatId, messageId, chunks[0]).catch(() => {})
    }
    // Send remaining chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      await this.api.sendMessage(chatId, chunks[i])
    }
  }

  // ── Group chat: collect then send once ────────────────────

  private async handleGroupChat(
    chatId: number,
    inbound: InboundMessage,
  ): Promise<void> {
    let accumulated = ''

    for await (const event of this.deps.chatHandle(inbound)) {
      if (event.type === 'delta' && event.content) {
        accumulated += event.content
      }
    }

    const finalText = accumulated || '(empty response)'
    const chunks = splitMessage(finalText)
    for (const chunk of chunks) {
      await this.api.sendMessage(chatId, chunk)
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  private pruneProcessedUpdates(): void {
    const now = Date.now()
    for (const [id, ts] of this.processedUpdates) {
      if (now - ts > DEDUP_TTL_MS) this.processedUpdates.delete(id)
    }
  }
}

// ── Utilities ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
