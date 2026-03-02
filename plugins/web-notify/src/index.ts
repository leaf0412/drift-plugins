import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Channel, OutgoingMessage } from '@drift/core'

// ── Types ────────────────────────────────────────────────

interface WsServer {
  broadcast(data: unknown): void
  onMessage?(handler: (ws: unknown, data: unknown) => void): void
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Extract a human-readable title from a message.
 * Inspects metadata.event for well-known event names, then falls back to
 * the first line of the content.
 */
function extractTitle(msg: OutgoingMessage): string {
  const event = msg.metadata?.event as string | undefined
  if (event) {
    // Use event name as title if no content prefix available
    return event
  }
  const firstLine = msg.content.split('\n')[0].replace(/^#+\s*/, '').trim()
  return firstLine.slice(0, 80) || 'Notification'
}

/**
 * Extract the body from a message, stripping any markdown heading that was
 * used as the title.
 */
function extractBody(msg: OutgoingMessage): string {
  return msg.content
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the web-notify channel plugin.
 *
 * Registers itself as a Channel capability (`channel.web-notify`) so the
 * notify plugin can discover it via `channel.list`.
 *
 * When a message is sent to this channel, it is broadcast via WebSocket
 * to all connected Web UI clients as a `notification` message.
 */
export function createWebNotifyPlugin(): DriftPlugin {
  let wsServer: WsServer | null = null

  return {
    name: 'web-notify',
    version: '0.1.0',
    requiresCapabilities: ['http.ws'],

    async init(ctx: PluginContext) {
      wsServer = await ctx.call<WsServer>('http.ws')

      const channel: Channel = {
        name: 'web-notify',
        capabilities: {
          streaming: false,
          richContent: false,
          fileUpload: false,
          interactive: false,
        },

        async send(msg: OutgoingMessage) {
          if (!wsServer) {
            ctx.logger.warn('[web-notify] WebSocket server not available, dropping notification')
            return
          }

          const title = extractTitle(msg)
          const body = extractBody(msg)

          ctx.logger.info(`[web-notify] broadcast notification: title="${title}"`)

          wsServer.broadcast({
            type: 'notification',
            payload: {
              title,
              body,
              timestamp: new Date().toISOString(),
            },
          })
        },
      }

      ctx.register('channel.web-notify', () => channel)
      ctx.logger.info('web-notify channel registered')
    },

    async stop() {
      wsServer = null
    },
  }
}

export default createWebNotifyPlugin
