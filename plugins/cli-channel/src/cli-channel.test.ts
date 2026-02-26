import { describe, it, expect, vi } from 'vitest'
import { createCliChannelPlugin } from './index.js'
import type { PluginContext, LoggerLike } from '@drift/core'
import { ChannelRouter } from '../../channel/src/index.js'

// ── Test helpers ──────────────────────────────────────────────

function makeLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeContext(logger: LoggerLike): PluginContext {
  const router = new ChannelRouter()
  const ctx = {
    tools: { register: vi.fn(), unregister: vi.fn(), list: vi.fn(() => []) },
    events: { on: vi.fn(() => () => {}), emit: vi.fn(async () => {}), off: vi.fn(), clear: vi.fn() },
    routes: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
    storage: { queryAll: vi.fn(() => []), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
    atoms: {
      atom: vi.fn((key: string) => {
        if (key === 'channel.router') {
          return { deref: () => router, swap: vi.fn(), reset: vi.fn(), watch: vi.fn() }
        }
        return { deref: vi.fn(), swap: vi.fn(), reset: vi.fn(), watch: vi.fn() }
      }),
      saveImage: vi.fn(),
      restoreImage: vi.fn(),
    },
    config: { get: vi.fn(), set: vi.fn() },
    logger,
    chat: vi.fn() as any,
    channels: { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: vi.fn(() => []), broadcast: vi.fn() },
    registerTool: vi.fn(),
    _router: router,
  }
  return ctx as unknown as PluginContext & { _router: ChannelRouter }
}

// ── Tests ─────────────────────────────────────────────────────

describe('cli-channel plugin', () => {
  it('has correct manifest', () => {
    const plugin = createCliChannelPlugin()
    expect(plugin.manifest.name).toBe('cli-channel')
    expect(plugin.manifest.depends).toContain('channel')
  })

  it('has init method', () => {
    const plugin = createCliChannelPlugin()
    expect(typeof plugin.init).toBe('function')
  })

  it('registers cli channel on init', async () => {
    const ctx = makeContext(makeLogger()) as any
    const plugin = createCliChannelPlugin()
    await plugin.init(ctx)

    const router: ChannelRouter = ctx._router
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
    const ctx = makeContext(makeLogger()) as any
    const plugin = createCliChannelPlugin()
    await plugin.init(ctx)

    const router: ChannelRouter = ctx._router
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
    await plugin.init(ctx)

    expect(logger.info).toHaveBeenCalledWith('CLI channel plugin initialized')
  })
})
