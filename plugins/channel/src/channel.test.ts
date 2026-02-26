import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AtomRegistry } from '@drift/core'
import type { PluginContext, LoggerLike } from '@drift/core'
import { Hono } from 'hono'
import { createChannelPlugin, getChannelRouter, processInbound } from './index.js'
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

function makeCtx(atoms: AtomRegistry, hooks?: HookPipeline): PluginContext {
  // Pre-seed atoms that registerPairingRoutes needs
  atoms.atom<Hono | null>('http.app', null).reset(new Hono())
  atoms.atom('storage.db', null).reset(mockDb)

  const ctx: PluginContext = {
    atoms,
    logger: noopLogger,
    tools: { register: () => {}, unregister: () => {}, list: () => [] },
    events: {
      on: () => () => {},
      emit: async () => {},
      off: () => {},
      clear: () => {},
    },
    routes: {
      get: () => {},
      post: () => {},
      put: () => {},
      delete: () => {},
    },
    storage: {
      queryAll: () => [],
      queryOne: () => undefined,
      execute: () => ({}),
      transaction: <T>(fn: () => T) => fn(),
    },
    config: {
      get: <T>(_k: string, d?: T) => d as T,
      set: () => {},
    },
    chat: async function* () {},
    channels: {
      register: () => {},
      unregister: () => {},
      get: () => undefined,
      list: () => [],
      broadcast: async () => {},
    },
  }
  // Store hooks in atoms so processInbound can find them
  if (hooks) {
    atoms.atom<HookPipeline | null>('channel.hooks', null).reset(hooks)
  }
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
  it('stores ChannelRouter in channel.router atom', async () => {
    const atoms = new AtomRegistry()
    const ctx = makeCtx(atoms)
    const plugin = createChannelPlugin()

    await plugin.init(ctx)

    const router = getChannelRouter(ctx)
    expect(router).toBeDefined()
    expect(typeof router.register).toBe('function')
  })

  it('getChannelRouter throws if plugin not initialized', () => {
    const atoms = new AtomRegistry()
    const ctx = makeCtx(atoms)

    expect(() => getChannelRouter(ctx)).toThrow('Channel plugin not initialized')
  })
})

describe('channel plugin: processInbound hook firing', () => {
  let atoms: AtomRegistry
  let hooks: HookPipeline
  let ctx: PluginContext

  beforeEach(async () => {
    atoms = new AtomRegistry()
    hooks = new HookPipeline()
    ctx = makeCtx(atoms, hooks)
    await createChannelPlugin().init(ctx)
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

  it('processInbound works without hooks (no hooks registered)', async () => {
    // Create a new context without hooks
    const cleanAtoms = new AtomRegistry()
    const cleanCtx = makeCtx(cleanAtoms)
    await createChannelPlugin().init(cleanCtx)

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
