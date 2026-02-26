import type { DriftChannel, MessagingAdapter, StreamingAdapter, InboundMessage, OutboundMessage } from './types.js'

// ── Options ──────────────────────────────────────────────────

export interface WebChannelOptions {
  /** Called whenever messaging.send() is invoked. Useful for wiring to HTTP response. */
  onSend?: (msg: OutboundMessage) => void | Promise<void>
  /** Called on each streaming write. */
  onStreamWrite?: (sessionId: string, event: OutboundMessage) => void | Promise<void>
  /** Called when a stream ends. */
  onStreamEnd?: (sessionId: string) => void | Promise<void>
}

// ── WebChannel ────────────────────────────────────────────────

/**
 * @deprecated Use `createWebChannelPlugin()` from `web-channel/index.ts`
 * instead, which registers a real DriftChannel on the ChannelRouter and
 * wires the SSE route.  This PoC is kept for its unit tests.
 *
 * A minimal DriftChannel implementation for the web (SSE) transport.
 *
 * This is a proof-of-concept that shows how DriftChannel wraps the
 * existing SSE streaming path. The `pushInbound()` method is the entry
 * point for HTTP POST /api/chat requests. The `onSend` / `onStreamWrite`
 * callbacks are wired to the actual HTTP response in a real integration.
 *
 * Full HTTP route migration is out of scope for Phase 3.
 */
export interface WebChannelInstance extends DriftChannel {
  /** Last message passed to messaging.send() -- useful for test inspection. */
  lastSent: OutboundMessage | undefined
  /** Push a message into this channel's inbound handlers (simulates HTTP request). */
  pushInbound(msg: InboundMessage): Promise<void>
}

export function createWebChannel(options: WebChannelOptions = {}): WebChannelInstance {
  const handlers = new Set<(msg: InboundMessage) => void | Promise<void>>()
  let lastSent: OutboundMessage | undefined

  const messaging: MessagingAdapter = {
    listen(handler) {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },

    async send(msg: OutboundMessage) {
      lastSent = msg
      if (options.onSend) await options.onSend(msg)
    },
  }

  const streaming: StreamingAdapter = {
    async startStream(_sessionId: string) {
      // No-op in base implementation; real integration sets up SSE response here
    },

    async write(sessionId: string, event: OutboundMessage) {
      if (options.onStreamWrite) await options.onStreamWrite(sessionId, event)
    },

    async end(sessionId: string) {
      if (options.onStreamEnd) await options.onStreamEnd(sessionId)
    },
  }

  return {
    id: 'web',
    meta: { name: 'Web', icon: 'browser', description: 'HTTP / SSE web channel' },
    capabilities: { text: true, streaming: true, files: true },
    messaging,
    streaming,

    get lastSent() { return lastSent },

    async pushInbound(msg: InboundMessage) {
      await Promise.all([...handlers].map(h => h(msg)))
    },
  }
}
