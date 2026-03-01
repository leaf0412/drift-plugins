import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCliChannelPlugin } from './index.js'
import type { PluginContext, LoggerLike } from '@drift/core/kernel'
import { createChannelPlugin, ChannelRouter } from '../../channel/src/index.js'
import { Hono } from 'hono'
import Database from 'better-sqlite3'

// ── Test helpers ──────────────────────────────────────────────

function makeLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

// Initialise channel plugin so _routerRegistry is populated
let channelRouter: ChannelRouter | null = null
let channelPluginRef: ReturnType<typeof createChannelPlugin> | null = null

async function initChannelPlugin(): Promise<ChannelRouter> {
  channelPluginRef = createChannelPlugin()
  const app = new Hono()
  const db = new Database(':memory:')
  const channelCtx = {
    pluginId: 'channel',
    logger: makeLogger(),
    register: vi.fn(),
    call: vi.fn(async (key: string, ..._args: unknown[]) => {
      if (key === 'http.app') return app
      if (key === 'sqlite.db') return db
      throw new Error(`Service not found: ${key}`)
    }),
    emit: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as PluginContext
  await channelPluginRef.init!(channelCtx)
  // capabilities are now declarative on the plugin object
  const routerHandler = channelPluginRef.capabilities!['channel.router']
  return routerHandler(undefined, undefined) as ChannelRouter
}

function makeContext(logger: LoggerLike): PluginContext & { _router: ChannelRouter } {
  const ctx = {
    pluginId: 'cli-channel',
    logger,
    register: vi.fn(),
    call: vi.fn(async (key: string) => {
      if (key === 'channel.router') return channelRouter!
    }),
    emit: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
    _router: channelRouter!,
  }
  return ctx as unknown as PluginContext & { _router: ChannelRouter }
}

// ── Tests ─────────────────────────────────────────────────────

describe('cli-channel plugin', () => {
  beforeEach(async () => {
    channelRouter = await initChannelPlugin()
  })

  afterEach(async () => {
    // Clean up the module-level registry via channel plugin's stop
    if (channelPluginRef?.stop) {
      await channelPluginRef.stop()
    }
  })

  it('has correct name', () => {
    const plugin = createCliChannelPlugin()
    expect(plugin.name).toBe('cli-channel')
  })

  it('has init method', () => {
    const plugin = createCliChannelPlugin()
    expect(typeof plugin.init).toBe('function')
  })

  it('registers cli channel on init', async () => {
    const ctx = makeContext(makeLogger())
    const plugin = createCliChannelPlugin()
    await plugin.init!(ctx)

    const router = ctx._router
    const channel = router.get('cli')
    expect(channel).toBeDefined()
    expect(channel!.id).toBe('cli')
    expect(channel!.meta.name).toBe('CLI')
    expect(channel!.meta.icon).toBe('terminal')
    expect(channel!.capabilities.text).toBe(true)
    expect(channel!.capabilities.streaming).toBe(true)
    expect(channel!.capabilities.files).toBe(false)
  })

  it('cli channel messaging adapters are no-ops', async () => {
    const ctx = makeContext(makeLogger())
    const plugin = createCliChannelPlugin()
    await plugin.init!(ctx)

    const router = ctx._router
    const channel = router.get('cli')!

    // listen returns a cleanup function
    const cleanup = channel.messaging.listen(() => {})
    expect(typeof cleanup).toBe('function')
    cleanup()

    // send is a no-op async function
    await expect(channel.messaging.send({ type: 'text', content: 'hello' })).resolves.toBeUndefined()
  })

  it('logs initialization message', async () => {
    const logger = makeLogger()
    const ctx = makeContext(logger)
    const plugin = createCliChannelPlugin()
    await plugin.init!(ctx)

    expect(logger.info).toHaveBeenCalledWith('CLI channel plugin initialized')
  })
})
