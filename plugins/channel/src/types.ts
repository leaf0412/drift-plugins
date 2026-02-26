// ── Inbound / Outbound Messages ─────────────────────────────────────────────

/**
 * A message arriving from an external channel into Drift.
 */
export interface InboundMessage {
  channelId: string
  sessionId: string
  content: string
  metadata?: Record<string, unknown>
}

/**
 * A message being sent from Drift to an external channel.
 */
export interface OutboundMessage {
  type: 'text' | 'card' | 'stream_delta' | 'error'
  content: string
  metadata?: Record<string, unknown>
}

// ── Adapters ────────────────────────────────────────────────────────────────

/**
 * Core adapter: receive inbound messages and send outbound replies.
 * Every DriftChannel must have exactly one MessagingAdapter.
 */
export interface MessagingAdapter {
  /**
   * Start listening for inbound messages.
   * Returns a cleanup function that unregisters the handler.
   */
  listen(handler: (msg: InboundMessage) => void | Promise<void>): () => void

  /**
   * Send an outbound message through this channel.
   */
  send(msg: OutboundMessage): Promise<void>
}

/**
 * Optional adapter: SSE / WebSocket streaming for real-time token delivery.
 */
export interface StreamingAdapter {
  /** Called when a new streaming session begins. */
  startStream(sessionId: string): Promise<void>

  /** Write a single streaming event to the client. */
  write(sessionId: string, event: OutboundMessage): Promise<void>

  /** Signal end-of-stream to the client. */
  end(sessionId: string): Promise<void>
}

/**
 * Optional adapter: push notifications to external systems (webhooks, etc.).
 */
export interface OutboundAdapter {
  push(msg: OutboundMessage): Promise<void>
}

// ── Channel Meta & Capabilities ─────────────────────────────────────────────

export interface ChannelMeta {
  name: string
  icon?: string
  description?: string
}

export interface ChannelCapabilities {
  text: boolean
  images?: boolean
  files?: boolean
  streaming?: boolean
  typing?: boolean
}

// ── DriftChannel ─────────────────────────────────────────────────────────────

/**
 * A named, capability-declared inbound/outbound channel.
 *
 * Required: `messaging` adapter — listens for input and sends replies.
 * Optional: `streaming` adapter — for SSE / WebSocket delivery.
 * Optional: `outbound` adapter — for push notifications.
 */
export interface DriftChannel {
  id: string
  meta: ChannelMeta
  capabilities: ChannelCapabilities
  messaging: MessagingAdapter
  streaming?: StreamingAdapter
  outbound?: OutboundAdapter
}

// ── ChatEvent ──────────────────────────────────────────────────────────────

/** Token usage stats. */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * Transport-agnostic chat stream events.
 *
 * These mirror the SSE event names (chat.delta, chat.tool_start, ...) but are
 * plain typed objects so that any channel -- SSE, WebSocket, Feishu callback,
 * CLI stdio -- can consume them without knowing about HTTP streaming.
 */
export type ChatEvent =
  | { type: 'delta'; sessionId: string; content: string }
  | { type: 'tool_start'; sessionId: string; toolCall: Record<string, unknown> }
  | { type: 'tool_delta'; sessionId: string; toolCallId: string; content: string }
  | { type: 'tool_update'; sessionId: string; toolCall: Record<string, unknown> }
  | { type: 'tool_result'; sessionId: string; toolCall: Record<string, unknown> }
  | { type: 'tool_confirm'; sessionId: string; toolCall: Record<string, unknown>; options: unknown[] }
  | { type: 'usage'; sessionId: string; usage: TokenUsage }
  | { type: 'complete'; sessionId: string; response: Record<string, unknown> }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'user_stored'; sessionId: string; userMessageId: string }
  | { type: 'assistant_stored'; sessionId: string; assistantMessageId: string }

/**
 * Handler type for processing inbound messages into ChatEvent streams.
 * Chat plugin registers this with the ChannelRouter.
 */
export type ChatHandler = (msg: InboundMessage) => AsyncIterable<ChatEvent>

// ── Session Isolation ───────────────────────────────────────────────

export interface SessionKey {
  channelId: string
  userId: string
}

// ── Channel Auth ────────────────────────────────────────────────────

export type AuthMode = 'token' | 'whitelist' | 'pairing'

export interface ChannelAuthConfig {
  mode: AuthMode
  tokens?: Record<string, { userId: string; permissions?: string[] }>
  allowedUsers?: string[]
  pairingTTL?: number
}

// ── Agent Routing ───────────────────────────────────────────────────

export interface AgentProfile {
  model: string
  tools?: string[] | 'all'
  systemPrompt?: string
  maxTokens?: number
  permissionMode?: 'bypass' | 'acceptEdits' | 'default'
}

export interface AgentRouteConfig {
  routing?: 'static' | 'intent'
  agent?: AgentProfile
  profiles?: Record<string, AgentProfile>
}

// ── Channel Config (plugin defaults + user overlay) ─────────────────

export interface ChannelConfig {
  auth?: ChannelAuthConfig | false
  agent?: AgentProfile | AgentRouteConfig | false
}
