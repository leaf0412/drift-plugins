// plugins/telegram/src/index.test.ts
import { describe, it, expect } from 'vitest'
import type { PluginContext, LoggerLike } from '@drift/core/kernel'
import type { Channel } from '@drift/core'
import { createTelegramPlugin } from './index.js'

const noopLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

let ctxCounter = 0

function createMockContext(): PluginContext {
  const pluginId = `telegram-test-${++ctxCounter}`
  const capabilities = new Map<string, (...args: unknown[]) => unknown>()

  return {
    pluginId,
    logger: noopLogger,
    register(name: string, handler: () => unknown) {
      capabilities.set(name, handler)
    },
    async call<T>(cap: string, _data?: unknown): Promise<T> {
      const handler = capabilities.get(cap)
      if (handler) return handler() as T
      throw new Error(`Capability not found: ${cap}`)
    },
    on: () => () => {},
    emit: () => {},
  } as unknown as PluginContext
}

describe('createTelegramPlugin', () => {
  it('returns valid DriftPlugin with correct name', () => {
    const plugin = createTelegramPlugin({ botToken: 'test:TOKEN' })
    expect(plugin.name).toBe('telegram')
  })

  it('init() registers telegram Channel when botToken is provided', async () => {
    const ctx = createMockContext()

    const plugin = createTelegramPlugin({ botToken: 'test:TOKEN', chatId: '123' })
    await plugin.init!(ctx)

    const channel = await ctx.call<Channel>('channel.telegram')
    expect(channel.name).toBe('telegram')
    expect(channel.capabilities.richContent).toBe(false)
  })

  it('init() skips channel registration when no botToken', async () => {
    const ctx = createMockContext()

    const plugin = createTelegramPlugin({})
    await plugin.init!(ctx)

    // No channel should be registered
    await expect(ctx.call<Channel>('channel.telegram')).rejects.toThrow('Capability not found')
  })
})
