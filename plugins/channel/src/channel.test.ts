import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginContext, LoggerLike } from '@drift/core/kernel'
import { Hono } from 'hono'
import { createChannelPlugin, getChannelRouter, getChannelHooks, processInbound } from './index.js'
import { HookPipeline } from './hooks.js'
import type { DriftChannel, InboundMessage, OutboundMessage } from './types.js'

// ── Helpers ──────────────────────────────────────────────────

const noopLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

/** Minimal mock DB that satisfies getStorageDb — routes won't be called in these tests. */
const mockDb = {} as any

let ctxCounter = 0

function makeCtx(): PluginContext {
  const pluginId = `channel-test-${++ctxCounter}`
  const capabilities = new Map<string, (...args: unknown[]) => unknown>()

  const ctx = {
    pluginId,
    logger: noopLogger,
    register(name: string, handler: () => unknown) {
      capabilities.set(name, handler)
    },
    async call<T>(cap: string, data?: unknown): Promise<T> {
      if (cap === 'http.app') return new Hono() as T
      if (cap === 'sqlite.db') return mockDb as T
      const handler = capabilities.get(cap)
      if (handler) return handler(data) as T
      throw new Error(`Capability not found: ${cap}`)
    },
    on: () => () => {},
    emit: () => {},
  } as unknown as PluginContext

  return ctx
}

function makeChannel(id: string): DriftChannel & { sentMessages: OutboundMessage[] } {
  const sentMessages: OutboundMessage[] = []
  return {
    id,
    meta: { name: id },
    capabilities: { text: true },
    messaging: {
      listen: () => () => {},
      send: async (msg) => { sentMessages.push(msg) },
    },
    sentMessages,
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe('createChannelPlugin', () => {
  it('registers ChannelRouter as capability', async () => {
    const ctx = makeCtx()
    const plugin = createChannelPlugin()

    await plugin.init!(ctx)

    const router = getChannelRouter(ctx)
    expect(router).toBeDefined()
    expect(typeof router.register).toBe('function')
  })

  it('getChannelRouter throws if plugin not initialized', async () => {
    // Ensure module-level registries are clean by stopping a plugin instance
    const tempPlugin = createChannelPlugin()
    await tempPlugin.init!(makeCtx())
    tempPlugin.stop!()

    const freshCtx = makeCtx()
    expect(() => getChannelRouter(freshCtx)).toThrow('Channel plugin not initialized')
  })
})

describe('channel plugin: processInbound hook firing', () => {
  let hooks: HookPipeline
  let ctx: PluginContext

  beforeEach(async () => {
    ctx = makeCtx()
    await createChannelPlugin().init!(ctx)
    // Get the hooks pipeline created by the plugin during init
    hooks = getChannelHooks(ctx)!
  })

  it('fires message_received hook when processInbound() is called', async () => {
    const router = getChannelRouter(ctx)
    const ch = makeChannel('web')
    router.register(ch)

    const receivedEvents: Array<{ from: string; content: string }> = []
    hooks.register({
      pluginId: 'test',
      hookName: 'message_received',
      handler: (event: any) => { receivedEvents.push({ from: event.from, content: event.content }) },
      priority: 0,
      source: 'test',
    })

    const reply: OutboundMessage = { type: 'text', content: 'ok' }
    const msg: InboundMessage = { channelId: 'web', sessionId: 's', content: 'ping' }

    await processInbound(ctx, msg, reply)

    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0].content).toBe('ping')
    expect(receivedEvents[0].from).toBe('web')
  })

  it('fires message_sending hook and allows content override', async () => {
    const router = getChannelRouter(ctx)
    const ch = makeChannel('cli')
    router.register(ch)

    hooks.register({
      pluginId: 'test',
      hookName: 'message_sending',
      handler: (_event: any) => ({ content: 'OVERRIDDEN' }),
      priority: 0,
      source: 'test',
    })

    const reply: OutboundMessage = { type: 'text', content: 'original' }
    const msg: InboundMessage = { channelId: 'cli', sessionId: 's', content: 'q' }

    await processInbound(ctx, msg, reply)

    expect(ch.sentMessages[0].content).toBe('OVERRIDDEN')
  })

  it('cancels send when message_sending hook returns cancel: true', async () => {
    const router = getChannelRouter(ctx)
    const ch = makeChannel('web')
    router.register(ch)

    hooks.register({
      pluginId: 'test',
      hookName: 'message_sending',
      handler: () => ({ cancel: true }),
      priority: 0,
      source: 'test',
    })

    const reply: OutboundMessage = { type: 'text', content: 'blocked' }
    const msg: InboundMessage = { channelId: 'web', sessionId: 's', content: 'q' }

    await processInbound(ctx, msg, reply)

    expect(ch.sentMessages).toHaveLength(0)
  })

  it('fires message_sent hook after successful send', async () => {
    const router = getChannelRouter(ctx)
    const ch = makeChannel('feishu')
    router.register(ch)

    const sentEvents: Array<{ to: string; success: boolean }> = []
    hooks.register({
      pluginId: 'test',
      hookName: 'message_sent',
      handler: (event: any) => { sentEvents.push({ to: event.to, success: event.success }) },
      priority: 0,
      source: 'test',
    })

    const reply: OutboundMessage = { type: 'text', content: 'hello feishu' }
    const msg: InboundMessage = { channelId: 'feishu', sessionId: 's', content: 'q' }

    await processInbound(ctx, msg, reply)

    expect(sentEvents).toHaveLength(1)
    expect(sentEvents[0].to).toBe('feishu')
    expect(sentEvents[0].success).toBe(true)
  })

  it('fires message_sent with success: false on send error', async () => {
    const router = getChannelRouter(ctx)
    const failCh: DriftChannel = {
      id: 'fail',
      meta: { name: 'fail' },
      capabilities: { text: true },
      messaging: {
        listen: () => () => {},
        send: async () => { throw new Error('network error') },
      },
    }
    router.register(failCh)

    const sentEvents: Array<{ success: boolean; error?: string }> = []
    hooks.register({
      pluginId: 'test',
      hookName: 'message_sent',
      handler: (event: any) => { sentEvents.push({ success: event.success, error: event.error }) },
      priority: 0,
      source: 'test',
    })

    const reply: OutboundMessage = { type: 'text', content: 'x' }
    const msg: InboundMessage = { channelId: 'fail', sessionId: 's', content: 'q' }

    // Should not throw — error is captured in hook
    await processInbound(ctx, msg, reply)

    expect(sentEvents[0].success).toBe(false)
    expect(sentEvents[0].error).toBe('network error')
  })

  it('processInbound works without hooks registered on the pipeline', async () => {
    // Create a new context — plugin creates a fresh HookPipeline with no hooks
    const cleanCtx = makeCtx()
    await createChannelPlugin().init!(cleanCtx)

    const router = getChannelRouter(cleanCtx)
    const ch = makeChannel('web')
    router.register(ch)

    const reply: OutboundMessage = { type: 'text', content: 'no hooks' }
    const msg: InboundMessage = { channelId: 'web', sessionId: 's', content: 'q' }

    await processInbound(cleanCtx, msg, reply)

    expect(ch.sentMessages).toHaveLength(1)
    expect(ch.sentMessages[0].content).toBe('no hooks')
  })
})
