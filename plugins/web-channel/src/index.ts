import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import type { DriftChannel, InboundMessage } from '@drift/plugins'
import { getChannelRouter, getChatHandle, getChatPending, getHttpApp } from '@drift/plugins'
import { chatEventsToSse } from './sse.js'

// ── Plugin Manifest ──────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'web-channel',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    routes: ['/api/chat'],
    channels: ['web'],
  },
  depends: ['http', 'chat', 'channel'],
}

// ── Plugin Factory ───────────────────────────────────────────

export function createWebChannelPlugin(): DriftPlugin {
  return {
    manifest,

    async init(ctx: PluginContext) {
      const router = getChannelRouter(ctx)
      const chatHandle = getChatHandle(ctx)
      const pendingApprovals = getChatPending(ctx)
      const app = getHttpApp(ctx)

      // Register as a DriftChannel on the ChannelRouter
      const webChannel: DriftChannel = {
        id: 'web',
        meta: { name: 'Web', icon: 'browser', description: 'HTTP / SSE web channel' },
        capabilities: { text: true, streaming: true, files: true },
        messaging: {
          listen: () => () => {},
          send: async () => {},
        },
      }
      router.register(webChannel)

      // ── POST /api/chat ──────────────────────────────────────

      app.post('/api/chat', async (c) => {
        const body = await c.req.json<{
          message: string
          sessionId?: string
          stream?: boolean
          cwd?: string
          clientType?: string
          permissionMode?: string
          model?: string
          source?: string
        }>()
        if (!body.message) {
          return c.json({ error: 'message is required' }, 400)
        }

        // Construct InboundMessage from HTTP request
        const inbound: InboundMessage = {
          channelId: 'web',
          sessionId: body.sessionId ?? '',
          content: body.message,
          metadata: {
            userId: 'owner',
            cwd: body.cwd,
            clientType: body.clientType ?? 'web',
            permissionMode: body.permissionMode,
            model: body.model,
            source: body.source ?? 'user',
          },
        }

        // Route through chat.handle (ChatHandler) → ChatEvent stream
        const chatEvents = chatHandle(inbound)

        if (body.stream) {
          return chatEventsToSse(chatEvents)
        }

        // Non-streaming: collect all events, return final response
        let lastResponse: Record<string, unknown> | undefined
        try {
          for await (const event of chatEvents) {
            if (event.type === 'complete') lastResponse = event.response
            if (event.type === 'error') return c.json({ error: event.error }, 500)
          }
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : 'Chat failed' }, 500)
        }
        return c.json(lastResponse ?? { error: 'No response' })
      })

      // ── POST /api/chat/confirm ──────────────────────────────

      app.post('/api/chat/confirm', async (c) => {
        if (!pendingApprovals) {
          return c.json({ error: 'Permission system not available' }, 501)
        }
        const { toolUseId, decision } = await c.req.json<{
          toolUseId: string
          decision: 'allow' | 'allow_always' | 'deny'
        }>()
        const entry = pendingApprovals.resolve(toolUseId)
        if (!entry) {
          return c.json({ error: 'No pending approval for this tool' }, 404)
        }
        pendingApprovals.remove(toolUseId)
        if (decision === 'allow' || decision === 'allow_always') {
          entry.resolve({ behavior: 'allow', updatedInput: entry.input })
        } else {
          entry.resolve({ behavior: 'deny', message: 'User denied permission' })
        }
        return c.json({ ok: true })
      })

      ctx.logger.info('Web channel plugin initialized')
    },
  }
}
