import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { AtomRegistry } from '@drift/core'
import type { PluginContext, LoggerLike, Channel, EventHandler } from '@drift/core'
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

function createMockContext(
  atoms: AtomRegistry,
  overrides?: Partial<PluginContext>,
): PluginContext {
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
  }
}

// ── Tests: Plugin ─────────────────────────────────────────

describe('createNotifyPlugin', () => {
  it('returns a valid DriftPlugin with correct manifest', () => {
    const plugin = createNotifyPlugin()

    expect(plugin.manifest.name).toBe('notify')
    expect(plugin.manifest.version).toBe('1.0.0')
    expect(plugin.manifest.type).toBe('code')
    expect(plugin.manifest.depends).toEqual(['storage', 'http'])
    expect(plugin.manifest.capabilities.events?.listen).toContain('chat.complete')
    expect(plugin.manifest.capabilities.events?.listen).toContain('cron.result')
    expect(plugin.manifest.capabilities.events?.listen).toContain('cron.notify')
    expect(plugin.manifest.capabilities.events?.listen).toContain('cron.chat')
    expect(typeof plugin.init).toBe('function')
  })

  it('init() subscribes to events and broadcasts to channels', async () => {
    const { db, dbPath } = makeTmpDb()
    const atoms = new AtomRegistry()
    atoms.atom<Database.Database | null>('storage.db', null).reset(db)
    atoms.atom<Hono | null>('http.app', null).reset(new Hono())

    const handlers = new Map<string, EventHandler>()
    const mockSend = vi.fn().mockResolvedValue(undefined)

    const mockChannel: Channel = {
      name: 'test-channel',
      capabilities: { streaming: false, richContent: false, fileUpload: false, interactive: false },
      send: mockSend,
    }

    const ctx = createMockContext(atoms, {
      events: {
        on: (event: string, handler: EventHandler) => {
          handlers.set(event, handler)
          return () => { handlers.delete(event) }
        },
        emit: async () => {},
        off: () => {},
        clear: () => {},
      },
      channels: {
        register: () => {},
        unregister: () => {},
        get: () => mockChannel,
        list: () => [mockChannel],
        broadcast: async () => {},
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init(ctx)

    // Verify all 4 event handlers were registered
    expect(handlers.has('chat.complete')).toBe(true)
    expect(handlers.has('cron.result')).toBe(true)
    expect(handlers.has('cron.notify')).toBe(true)
    expect(handlers.has('cron.chat')).toBe(true)

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
    const atoms = new AtomRegistry()
    atoms.atom<Database.Database | null>('storage.db', null).reset(db)
    atoms.atom<Hono | null>('http.app', null).reset(new Hono())

    const handlers = new Map<string, EventHandler>()
    const mockSend = vi.fn().mockRejectedValue(new Error('send failed'))

    const mockChannel: Channel = {
      name: 'broken-channel',
      capabilities: { streaming: false, richContent: false, fileUpload: false, interactive: false },
      send: mockSend,
    }

    const ctx = createMockContext(atoms, {
      events: {
        on: (event: string, handler: EventHandler) => {
          handlers.set(event, handler)
          return () => { handlers.delete(event) }
        },
        emit: async () => {},
        off: () => {},
        clear: () => {},
      },
      channels: {
        register: () => {},
        unregister: () => {},
        get: () => mockChannel,
        list: () => [mockChannel],
        broadcast: async () => {},
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init(ctx)

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
    const atoms = new AtomRegistry()
    atoms.atom<Database.Database | null>('storage.db', null).reset(db)
    atoms.atom<Hono | null>('http.app', null).reset(new Hono())

    const unsubCalls: string[] = []

    const ctx = createMockContext(atoms, {
      events: {
        on: (event: string, _handler: EventHandler) => {
          return () => { unsubCalls.push(event) }
        },
        emit: async () => {},
        off: () => {},
        clear: () => {},
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init(ctx)

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
    const atoms = new AtomRegistry()
    atoms.atom<Database.Database | null>('storage.db', null).reset(db)
    atoms.atom<Hono | null>('http.app', null).reset(new Hono())

    const handlers = new Map<string, EventHandler>()
    const mockSend = vi.fn().mockResolvedValue(undefined)
    const mockChannel: Channel = {
      name: 'ch',
      capabilities: { streaming: false, richContent: false, fileUpload: false, interactive: false },
      send: mockSend,
    }

    const ctx = createMockContext(atoms, {
      events: {
        on: (event: string, handler: EventHandler) => {
          handlers.set(event, handler)
          return () => {}
        },
        emit: async () => {},
        off: () => {},
        clear: () => {},
      },
      channels: {
        register: () => {},
        unregister: () => {},
        get: () => mockChannel,
        list: () => [mockChannel],
        broadcast: async () => {},
      },
    })

    const plugin = createNotifyPlugin()
    await plugin.init(ctx)

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
