/**
 * Feishu Bot -- WSClient long-poll mode
 *
 * Encapsulates the official SDK WebSocket full-duplex channel for receiving
 * messages.  No public domain, no encryption/decryption, no HTTP callback
 * endpoint needed.
 */
import { homedir } from 'node:os'
import * as lark from '@larksuiteoapi/node-sdk'
import type { InboundMessage, ChatEvent } from '@drift/plugins'
import type { LoggerLike } from '@drift/core'

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
    mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>
  }
}

// ── Constants ────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000
const UPDATE_INTERVAL_MS = 1500

// ── Class ────────────────────────────────────────────────

export class FeishuWsClient {
  private wsClient: lark.WSClient | null = null
  private apiClient: lark.Client | null = null
  private processedEvents = new Map<string, number>()
  private config: FeishuWsConfig
  private deps: FeishuWsDeps

  constructor(config: FeishuWsConfig, deps: FeishuWsDeps) {
    this.config = config
    this.deps = deps
  }

  // ── Lifecycle ────────────────────────────────────────

  start(): void {
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
    // SDK WSClient has no explicit close method; nulling out is sufficient
    this.wsClient = null
    this.apiClient = null
    this.processedEvents.clear()
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

  // ── Message handler ──────────────────────────────────

  private async handleIncomingMessage(
    data: FeishuMessageEvent,
    allowFrom: string[],
  ): Promise<void> {
    const { message: msg, sender } = data

    const messageId = msg.message_id
    const chatId = msg.chat_id
    const msgType = msg.message_type
    const contentStr = msg.content
    const senderId = sender.sender_id?.open_id

    // Event de-duplication
    if (this.processedEvents.has(messageId)) return
    this.processedEvents.set(messageId, Date.now())
    this.pruneProcessedEvents()

    // Allow-list check (empty list = allow all)
    if (allowFrom.length > 0 && senderId && !allowFrom.includes(senderId)) {
      this.deps.logger.debug(`Feishu bot: ignored message from ${senderId} (not in allowFrom)`)
      return
    }

    // Only text messages are supported
    if (msgType !== 'text') {
      await this.sendText(chatId, '暂只支持文本消息 🙏')
      return
    }

    // Parse text, strip @mention placeholders
    let text: string
    try {
      const parsed = JSON.parse(contentStr)
      text = (parsed.text as string || '').replace(/@_user_\d+/g, '').trim()
    } catch {
      text = contentStr
    }

    if (!text) return

    // /clear command: reset session context
    if (text === '/clear') {
      const prefix = `feishu:${senderId}:`
      const count = this.deps.deleteSessionsByPrefix(prefix)
      await this.sendText(chatId, '上下文已清除 ✨')
      this.deps.logger.info(`Feishu bot: cleared ${count} session(s) with prefix ${prefix}`)
      return
    }

    this.deps.logger.info(`Feishu bot: received from ${senderId}: ${text.slice(0, 80)}`)

    // Send a "thinking" placeholder first, then stream-update it
    const replyMsgId = await this.sendText(chatId, '思考中…')

    try {
      let segmentContent = ''   // current paragraph text
      let currentMsgId = replyMsgId  // Feishu message being updated
      let lastUpdateAt = 0
      let inToolUse = false

      const inbound: InboundMessage = {
        channelId: 'feishu',
        sessionId: '',
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
            currentMsgId = await this.sendText(chatId, '…')
            inToolUse = false
          }
          segmentContent += event.content

          if (currentMsgId && now - lastUpdateAt >= UPDATE_INTERVAL_MS) {
            lastUpdateAt = now
            this.updateText(currentMsgId, segmentContent + ' ▍')
          }
        } else if (event.type === 'tool_start') {
          inToolUse = true
          const toolName = (event.toolCall as Record<string, unknown>)?.name || 'tool'
          if (currentMsgId && now - lastUpdateAt >= UPDATE_INTERVAL_MS) {
            lastUpdateAt = now
            this.updateText(currentMsgId, (segmentContent || '思考中…') + `\n\n⏳ ${toolName}...`)
          }
        }
      }

      // Final segment — remove cursor indicator
      if (currentMsgId && segmentContent) {
        await this.updateText(currentMsgId, segmentContent)
      }
    } catch (err) {
      this.deps.logger.error('Feishu bot: chat error', err)
      if (replyMsgId) {
        await this.updateText(replyMsgId, '处理消息时出错，请稍后重试')
      } else {
        await this.sendText(chatId, '处理消息时出错，请稍后重试')
      }
    }
  }
}
