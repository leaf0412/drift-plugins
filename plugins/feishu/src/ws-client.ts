/**
 * Feishu Bot -- WSClient long-poll mode
 *
 * Encapsulates the official SDK WebSocket full-duplex channel for receiving
 * messages.  No public domain, no encryption/decryption, no HTTP callback
 * endpoint needed.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import * as lark from '@larksuiteoapi/node-sdk'
import type { InboundMessage, ChatEvent } from '@drift/plugins'
import type { LoggerLike } from '@drift/core/kernel'

// ── Config & Deps ────────────────────────────────────────

export interface FeishuWsConfig {
  appId: string
  appSecret: string
  allowFrom?: string[]
}

export type ChatHandleFn = (msg: InboundMessage) => AsyncIterable<ChatEvent>

export type DeleteSessionFn = (sessionId: string) => boolean
export type DeleteSessionsByPrefixFn = (prefix: string) => number

export interface FeishuWsDeps {
  chatHandle: ChatHandleFn
  deleteSession: DeleteSessionFn
  deleteSessionsByPrefix: DeleteSessionsByPrefixFn
  logger: LoggerLike
}

// ── Internal types ───────────────────────────────────────

/** SDK event callback shape for im.message.receive_v1 */
interface FeishuMessageEvent {
  sender: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string }
    sender_type: string
  }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    create_time?: string // Unix timestamp in ms
    mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>
  }
}

// ── Constants ────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000
const UPDATE_INTERVAL_MS = 1500
const SEND_RETRY_DELAYS = [2000, 4000, 6000]

// ── Class ────────────────────────────────────────────────

export class FeishuWsClient {
  private wsClient: lark.WSClient | null = null
  private apiClient: lark.Client | null = null
  private processedEvents = new Map<string, number>()
  private startedAt = 0 // reject messages created before this
  private config: FeishuWsConfig
  private deps: FeishuWsDeps

  // Fix #2: per-user concurrency queue
  private userQueues = new Map<string, Promise<void>>()
  // Fix #1: session token for /new command
  private newSessionTokens = new Map<string, string>()

  constructor(config: FeishuWsConfig, deps: FeishuWsDeps) {
    this.config = config
    this.deps = deps
  }

  // ── Lifecycle ────────────────────────────────────────

  start(): void {
    this.startedAt = Date.now()

    const baseConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: lark.Domain.Feishu,
    }

    this.apiClient = new lark.Client(baseConfig)

    const allowFrom = this.config.allowFrom ?? []

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: FeishuMessageEvent) => {
        await this.handleIncomingMessage(data, allowFrom)
      },
    })

    this.wsClient = new lark.WSClient({
      ...baseConfig,
      loggerLevel: lark.LoggerLevel.info,
    })
    this.wsClient.start({ eventDispatcher: dispatcher })

    this.deps.logger.info('Feishu bot: WSClient started')
  }

  stop(): void {
    if (!this.wsClient) return
    this.wsClient = null
    this.apiClient = null
    this.processedEvents.clear()
    this.userQueues.clear()
    this.newSessionTokens.clear()
    this.deps.logger.info('Feishu bot: stopped')
  }

  // ── Lark API helpers ─────────────────────────────────

  private async sendText(chatId: string, text: string): Promise<string | undefined> {
    if (!this.apiClient) return undefined
    try {
      const res = await this.apiClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
      return (res.data as Record<string, unknown>)?.message_id as string | undefined
    } catch (err) {
      this.deps.logger.error('Feishu bot: failed to send message', err)
      return undefined
    }
  }

  // Fix #3: sendText with retry + exponential backoff
  private async sendTextWithRetry(chatId: string, text: string): Promise<string | undefined> {
    for (let attempt = 0; attempt <= SEND_RETRY_DELAYS.length; attempt++) {
      const msgId = await this.sendText(chatId, text)
      if (msgId) return msgId
      if (attempt < SEND_RETRY_DELAYS.length) {
        const delay = SEND_RETRY_DELAYS[attempt]
        this.deps.logger.warn(`Feishu bot: sendText failed, retrying in ${delay}ms (attempt ${attempt + 1})`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    this.deps.logger.error('Feishu bot: sendText exhausted all retries')
    return undefined
  }

  private async updateText(messageId: string, text: string): Promise<void> {
    if (!this.apiClient) return
    try {
      await this.apiClient.im.v1.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    } catch (err) {
      this.deps.logger.error('Feishu bot: failed to update message', err)
    }
  }

  // ── Event de-duplication ─────────────────────────────

  private pruneProcessedEvents(): void {
    const now = Date.now()
    for (const [id, ts] of this.processedEvents) {
      if (now - ts > DEDUP_TTL_MS) this.processedEvents.delete(id)
    }
  }

  // ── Concurrency queue ────────────────────────────────

  // Fix #2: per-user promise chain — serializes message processing
  private enqueueForUser(key: string, task: () => Promise<void>): void {
    const prev = this.userQueues.get(key) ?? Promise.resolve()
    const next = prev.then(task, task) // always advance regardless of success/failure
    this.userQueues.set(key, next)
    next.then(() => {
      if (this.userQueues.get(key) === next) this.userQueues.delete(key)
    })
  }

  // ── Message handler (thin: dedup + enqueue) ──────────

  private async handleIncomingMessage(
    data: FeishuMessageEvent,
    allowFrom: string[],
  ): Promise<void> {
    const { message: msg, sender } = data

    const messageId = msg.message_id
    const chatId = msg.chat_id
    const senderId = sender.sender_id?.open_id

    // Event de-duplication
    if (this.processedEvents.has(messageId)) return
    this.processedEvents.set(messageId, Date.now())
    this.pruneProcessedEvents()

    // Reject stale messages replayed by Feishu after restart
    const createTimeMs = msg.create_time ? Number(msg.create_time) : 0
    if (createTimeMs > 0 && createTimeMs < this.startedAt) {
      this.deps.logger.info(`Feishu bot: skipped stale message ${messageId} (created ${Math.round((this.startedAt - createTimeMs) / 1000)}s before start)`)
      return
    }

    // Allow-list check
    if (allowFrom.length > 0 && senderId && !allowFrom.includes(senderId)) {
      this.deps.logger.debug(`Feishu bot: ignored message from ${senderId} (not in allowFrom)`)
      return
    }

    // Only text messages
    if (msg.message_type !== 'text') {
      await this.sendText(chatId, '暂只支持文本消息 🙏')
      return
    }

    // Parse text, strip @mention placeholders
    let text: string
    try {
      const parsed = JSON.parse(msg.content)
      text = (parsed.text as string || '').replace(/@_user_\d+/g, '').trim()
    } catch {
      text = msg.content
    }

    if (!text) return

    // Fix #2: enqueue to per-user serial queue
    const queueKey = `${chatId}:${senderId}`
    this.enqueueForUser(queueKey, () => this.processMessage(chatId, senderId, text))
  }

  // ── Core message processing (serialized per user) ────

  private async processMessage(chatId: string, senderId: string | undefined, text: string): Promise<void> {
    const sessionKey = `${chatId}:${senderId}`

    // Fix #6: /new command — start fresh session
    if (text === '/new') {
      this.newSessionTokens.set(sessionKey, randomUUID().slice(0, 8))
      await this.sendTextWithRetry(chatId, '已开启新会话 ✨')
      return
    }

    // Fix #7: /clear command — correct prefix scope
    if (text === '/clear') {
      const prefix = `feishu:${chatId}:${senderId}:`
      const count = this.deps.deleteSessionsByPrefix(prefix)
      this.newSessionTokens.delete(sessionKey)
      await this.sendTextWithRetry(chatId, '上下文已清除 ✨')
      this.deps.logger.info(`Feishu bot: cleared ${count} session(s) with prefix ${prefix}`)
      return
    }

    this.deps.logger.info(`Feishu bot: received from ${senderId}: ${text.slice(0, 80)}`)

    // Fix #3: use retry for the "thinking" placeholder
    const replyMsgId = await this.sendTextWithRetry(chatId, '思考中…')

    try {
      let segmentContent = ''
      let currentMsgId = replyMsgId
      let lastUpdateAt = 0
      let inToolUse = false

      // Fix #1: stable sessionId based on chatId + senderId
      const suffix = this.newSessionTokens.get(sessionKey) ?? 'default'
      const sessionId = `feishu:${chatId}:${senderId}:${suffix}`

      const inbound: InboundMessage = {
        channelId: 'feishu',
        sessionId,
        content: text,
        metadata: { userId: senderId, cwd: homedir() },
      }

      for await (const event of this.deps.chatHandle(inbound)) {
        const now = Date.now()

        if (event.type === 'delta') {
          if (inToolUse) {
            // Tool call ended, new text segment -> send new message
            if (currentMsgId && segmentContent) {
              await this.updateText(currentMsgId, segmentContent)
            }
            segmentContent = ''
            currentMsgId = await this.sendTextWithRetry(chatId, '…')
            inToolUse = false
          }
          segmentContent += event.content

          // Fix #5: await updateText
          if (currentMsgId && now - lastUpdateAt >= UPDATE_INTERVAL_MS) {
            lastUpdateAt = now
            await this.updateText(currentMsgId, segmentContent + ' ▍')
          }
        } else if (event.type === 'tool_start') {
          inToolUse = true
          const toolName = (event.toolCall as Record<string, unknown>)?.name || 'tool'
          // Fix #5: await updateText
          if (currentMsgId && now - lastUpdateAt >= UPDATE_INTERVAL_MS) {
            lastUpdateAt = now
            await this.updateText(currentMsgId, (segmentContent || '思考中…') + `\n\n⏳ ${toolName}...`)
          }
        } else if (event.type === 'error') {
          // Fix #4: handle error events
          this.deps.logger.error('Feishu bot: stream error', (event as Record<string, unknown>).error)
          const errText = '⚠️ AI 出错，请稍后重试'
          if (currentMsgId) await this.updateText(currentMsgId, errText)
          else await this.sendTextWithRetry(chatId, errText)
          return
        }
      }

      // Final segment — remove cursor indicator
      if (currentMsgId && segmentContent) {
        await this.updateText(currentMsgId, segmentContent)
      } else if (!currentMsgId && segmentContent) {
        // Fix #3: fallback — send full reply as new message if placeholder failed
        await this.sendTextWithRetry(chatId, segmentContent)
      }
    } catch (err) {
      this.deps.logger.error('Feishu bot: chat error', err)
      if (replyMsgId) {
        await this.updateText(replyMsgId, '处理消息时出错，请稍后重试')
      } else {
        await this.sendTextWithRetry(chatId, '处理消息时出错，请稍后重试')
      }
    }
  }
}
