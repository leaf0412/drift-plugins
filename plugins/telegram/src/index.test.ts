// plugins/telegram/src/index.test.ts
import { describe, it, expect } from 'vitest'
import { AtomRegistry } from '@drift/core'
import type { PluginContext, LoggerLike, Channel } from '@drift/core'
import { createTelegramPlugin } from './index.js'

const noopLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

function createMockContext(overrides?: Partial<PluginContext>): PluginContext {
  const atoms = new AtomRegistry()
  return {
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
    ...overrides,
  } as PluginContext
}

describe('createTelegramPlugin', () => {
  it('returns valid DriftPlugin with correct manifest', () => {
    const plugin = createTelegramPlugin({ botToken: 'test:TOKEN' })
    expect(plugin.manifest.name).toBe('telegram')
    expect(plugin.manifest.version).toBe('1.0.0')
    expect(plugin.manifest.capabilities.network).toBe(true)
    expect(plugin.manifest.depends).toContain('chat')
  })

  it('init() registers telegram Channel when botToken is provided', async () => {
    const registered: Channel[] = []
    const ctx = createMockContext({
      channels: {
        register: (ch: Channel) => { registered.push(ch) },
        unregister: () => {},
        get: () => undefined,
        list: () => [],
        broadcast: async () => {},
      },
    })

    const plugin = createTelegramPlugin({ botToken: 'test:TOKEN', chatId: '123' })
    await plugin.init(ctx)

    expect(registered.length).toBe(1)
    expect(registered[0].name).toBe('telegram')
    expect(registered[0].capabilities.richContent).toBe(false)
  })

  it('init() skips channel registration when no botToken', async () => {
    const registered: Channel[] = []
    const ctx = createMockContext({
      channels: {
        register: (ch: Channel) => { registered.push(ch) },
        unregister: () => {},
        get: () => undefined,
        list: () => [],
        broadcast: async () => {},
      },
    })

    const plugin = createTelegramPlugin({})
    await plugin.init(ctx)

    expect(registered.length).toBe(0)
  })
})
