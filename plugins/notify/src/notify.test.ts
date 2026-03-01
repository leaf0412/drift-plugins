import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import type { PluginContext, LoggerLike } from '@drift/core/kernel'
import type { Channel } from '@drift/core'
import { SCHEMA_SQL } from '@drift/plugins'
import { createNotifyPlugin } from './index.js'
import { logNotification, listNotifications } from './notification-log.js'

// ── Helpers ─────────────────────────────────────────────────

function makeTmpDb(): { db: Database.Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-notify-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return { db, dbPath }
}

function cleanupPath(dbPath: string): void {
  const dir = dirname(dbPath)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

const noopLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

type EventHandler = (data: unknown) => void | Promise<void>

let ctxCounter = 0

interface MockCtxOptions {
  db: Database.Database
  channels?: Channel[]
  onSubscribe?: (event: string, handler: EventHandler) => () => void
}

function createMockContext(opts: MockCtxOptions): PluginContext {
  const pluginId = `notify-test-${++ctxCounter}`
  const capabilities = new Map<string, (...args: unknown[]) => unknown>()
  const eventHandlers = new Map<string, EventHandler>()

  const ctx = {
    pluginId,
    logger: noopLogger,
    register(name: string, handler: (...args: unknown[]) => unknown) {
      capabilities.set(name, handler)
    },
    async call<T>(cap: string, data?: unknown): Promise<T> {
      if (cap === 'sqlite.db') return opts.db as T
      if (cap === 'http.app') return new Hono() as T
      if (cap === 'channel.list') return (opts.channels ?? []) as T
      // channel.<name> lookup
      if (cap.startsWith('channel.')) {
        const name = cap.slice('channel.'.length)
        const ch = (opts.channels ?? []).find(c => c.name === name)
        if (ch) return ch as T
      }
      const handler = capabilities.get(cap)
      if (handler) return handler(data) as T
      throw new Error(`Capability not found: ${cap}`)
    },
    on(event: string, handler: EventHandler): () => void {
      if (opts.onSubscribe) {
        return opts.onSubscribe(event, handler)
      }
      eventHandlers.set(event, handler)
      return () => { eventHandlers.delete(event) }
    },
    emit: () => {},
    // Expose event handlers for test assertions
    _eventHandlers: eventHandlers,
  }

  return ctx as unknown as PluginContext
}

// ── Tests: Plugin ─────────────────────────────────────────

describe('createNotifyPlugin', () => {
  it('returns a valid DriftPlugin with correct name', () => {
    const plugin = createNotifyPlugin()

    expect(plugin.name).toBe('notify')
    expect(typeof plugin.init).toBe('function')
  })

  it('init() subscribes to events and broadcasts to channels', async () => {
    const { db, dbPath } = makeTmpDb()

    const handlers = new Map<string, EventHandler>()
    const mockSend = vi.fn().mockResolvedValue(undefined)

    const mockChannel: Channel = {
      name: 'test-channel',
      capabilities: { streaming: false, richContent: false, fileUpload: false, interactive: false },
      send: mockSend,
    }

    const ctx = createMockContext({
      db,
      channels: [mockChannel],
      onSubscribe: (event, handler) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init!(ctx)

    // Verify all 5 event handlers were registered
    expect(handlers.has('chat.complete')).toBe(true)
    expect(handlers.has('cron.result')).toBe(true)
    expect(handlers.has('cron.notify')).toBe(true)
    expect(handlers.has('cron.chat')).toBe(true)
    expect(handlers.has('task.reminder')).toBe(true)

    // Simulate chat.complete event
    await handlers.get('chat.complete')!({ content: 'hello', model: 'test' })

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'text',
        metadata: { event: 'chat.complete' },
      }),
    )

    // Verify notification was logged as success
    const logs = listNotifications(db, 10)
    expect(logs.length).toBe(1)
    expect(logs[0].channel).toBe('test-channel')
    expect(logs[0].eventType).toBe('chat.complete')
    expect(logs[0].status).toBe('success')

    db.close()
    cleanupPath(dbPath)
  })

  it('logs failure when channel.send throws', async () => {
    const { db, dbPath } = makeTmpDb()

    const handlers = new Map<string, EventHandler>()
    const mockSend = vi.fn().mockRejectedValue(new Error('send failed'))

    const mockChannel: Channel = {
      name: 'broken-channel',
      capabilities: { streaming: false, richContent: false, fileUpload: false, interactive: false },
      send: mockSend,
    }

    const ctx = createMockContext({
      db,
      channels: [mockChannel],
      onSubscribe: (event, handler) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init!(ctx)

    // Simulate cron.notify event
    await handlers.get('cron.notify')!({ jobName: 'test-job', message: 'hi' })

    const logs = listNotifications(db, 10)
    expect(logs.length).toBe(1)
    expect(logs[0].channel).toBe('broken-channel')
    expect(logs[0].status).toBe('failed')
    expect(logs[0].errorMsg).toBe('send failed')

    db.close()
    cleanupPath(dbPath)
  })

  it('stop() unsubscribes all event handlers', async () => {
    const { db, dbPath } = makeTmpDb()

    const unsubCalls: string[] = []

    const ctx = createMockContext({
      db,
      onSubscribe: (event, _handler) => {
        return () => { unsubCalls.push(event) }
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init!(ctx)

    await plugin.stop!()

    // All 5 event subscriptions should have been unsubscribed
    expect(unsubCalls.length).toBe(5)
    expect(unsubCalls).toContain('chat.complete')
    expect(unsubCalls).toContain('cron.result')
    expect(unsubCalls).toContain('cron.notify')
    expect(unsubCalls).toContain('cron.chat')
    expect(unsubCalls).toContain('task.reminder')

    db.close()
    cleanupPath(dbPath)
  })

  it('extracts title from event data (jobName > title > event name)', async () => {
    const { db, dbPath } = makeTmpDb()

    const handlers = new Map<string, EventHandler>()
    const mockSend = vi.fn().mockResolvedValue(undefined)
    const mockChannel: Channel = {
      name: 'ch',
      capabilities: { streaming: false, richContent: false, fileUpload: false, interactive: false },
      send: mockSend,
    }

    const ctx = createMockContext({
      db,
      channels: [mockChannel],
      onSubscribe: (event, handler) => {
        handlers.set(event, handler)
        return () => {}
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init!(ctx)

    // Test jobName extraction
    await handlers.get('cron.result')!({ jobName: 'my-cron-job' })
    const logs1 = listNotifications(db, 10)
    expect(logs1[0].title).toBe('my-cron-job')

    // Test title extraction (no jobName)
    await handlers.get('chat.complete')!({ title: 'my-chat-title' })
    const logs2 = listNotifications(db, 10)
    expect(logs2[0].title).toBe('my-chat-title')

    // Test fallback to event name
    await handlers.get('cron.chat')!('plain string data')
    const logs3 = listNotifications(db, 10)
    expect(logs3[0].title).toBe('cron.chat')

    db.close()
    cleanupPath(dbPath)
  })
})

// ── Tests: notification-log ───────────────────────────────

describe('notification-log', () => {
  let db: Database.Database
  let dbPath: string

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    dbPath = tmp.dbPath
  })

  afterEach(() => {
    db.close()
    cleanupPath(dbPath)
  })

  it('logNotification inserts a row into notification_log', () => {
    logNotification(db, {
      channel: 'feishu',
      eventType: 'chat.complete',
      title: 'Test Chat',
      status: 'success',
    })

    const rows = db.prepare('SELECT * FROM notification_log').all() as Record<string, unknown>[]
    expect(rows.length).toBe(1)
    expect(rows[0].channel).toBe('feishu')
    expect(rows[0].event_type).toBe('chat.complete')
    expect(rows[0].title).toBe('Test Chat')
    expect(rows[0].status).toBe('success')
    expect(rows[0].error_msg).toBeNull()
  })

  it('logNotification stores error message on failure', () => {
    logNotification(db, {
      channel: 'feishu',
      eventType: 'cron.result',
      title: 'Failed Job',
      status: 'failed',
      errorMsg: 'Connection timeout',
    })

    const rows = db.prepare('SELECT * FROM notification_log').all() as Record<string, unknown>[]
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('failed')
    expect(rows[0].error_msg).toBe('Connection timeout')
  })

  it('listNotifications returns entries in descending order by created_at', () => {
    for (let i = 0; i < 3; i++) {
      logNotification(db, {
        channel: 'feishu',
        eventType: 'cron.notify',
        title: `Job ${i}`,
        status: 'success',
      })
    }

    const entries = listNotifications(db, 10)
    expect(entries.length).toBe(3)
    expect(entries[0].title).toBe('Job 2')
    expect(entries[2].title).toBe('Job 0')
  })

  it('listNotifications respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      logNotification(db, {
        channel: 'ch',
        eventType: 'test',
        title: `Entry ${i}`,
        status: 'success',
      })
    }

    const entries = listNotifications(db, 2)
    expect(entries.length).toBe(2)
  })

  it('listNotifications returns proper NotificationLogEntry shape', () => {
    logNotification(db, {
      channel: 'feishu',
      eventType: 'chat.complete',
      title: 'Shape Test',
      status: 'success',
    })

    const entries = listNotifications(db, 1)
    expect(entries.length).toBe(1)

    const entry = entries[0]
    expect(typeof entry.id).toBe('string')
    expect(entry.id.length).toBeGreaterThan(0)
    expect(entry.channel).toBe('feishu')
    expect(entry.eventType).toBe('chat.complete')
    expect(entry.title).toBe('Shape Test')
    expect(entry.status).toBe('success')
    expect(entry.errorMsg).toBeNull()
    expect(typeof entry.createdAt).toBe('string')
  })
})
