import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'
import { SCHEMA_SQL } from '@drift/plugins'
import { registerNotifyRoutes, type NotifyRouteDeps } from './routes.js'
import { logNotification } from './notification-log.js'

// ── Helpers ─────────────────────────────────────────────────

function makeTmpDb(): { db: Database.Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-notify-routes-'))
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

function insertEvent(
  db: Database.Database,
  opts: { type?: string; title?: string; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO event_log (id, type, title, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    nanoid(),
    opts.type ?? 'test',
    opts.title ?? 'Test Event',
    opts.status ?? 'ok',
    dayjs().toISOString(),
  )
}

// ── Tests ───────────────────────────────────────────────────

describe('registerNotifyRoutes', () => {
  let db: Database.Database
  let dbPath: string
  let app: Hono
  let sendNotify: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    dbPath = tmp.dbPath
    app = new Hono()
    sendNotify = vi.fn().mockResolvedValue(undefined)

    const deps: NotifyRouteDeps = { db, sendNotify }
    registerNotifyRoutes(app, deps)
  })

  afterEach(() => {
    db.close()
    cleanupPath(dbPath)
  })

  // ── POST /api/notify ──────────────────────────────────

  describe('POST /api/notify', () => {
    it('returns 400 without required fields', async () => {
      const res = await app.request('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('title and body are required')
    })

    it('returns 200 with valid body and calls sendNotify', async () => {
      const res = await app.request('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Alert', body: 'Something happened' }),
      })

      expect(res.status).toBe(200)
      const data = (await res.json()) as { ok: boolean }
      expect(data.ok).toBe(true)

      expect(sendNotify).toHaveBeenCalledTimes(1)
      expect(sendNotify).toHaveBeenCalledWith('Alert', 'Something happened', undefined)
    })

    it('passes channel to sendNotify when provided', async () => {
      const res = await app.request('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Alert', body: 'msg', channel: 'feishu' }),
      })

      expect(res.status).toBe(200)
      expect(sendNotify).toHaveBeenCalledWith('Alert', 'msg', 'feishu')
    })

    it('returns 400 when sendNotify throws', async () => {
      sendNotify.mockRejectedValueOnce(new Error('No channels configured'))

      const res = await app.request('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Fail', body: 'test' }),
      })

      expect(res.status).toBe(400)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('No channels configured')
    })
  })

  // ── POST /api/notify/test ─────────────────────────────

  describe('POST /api/notify/test', () => {
    it('returns 200 and calls sendNotify with test payload', async () => {
      const res = await app.request('/api/notify/test', { method: 'POST' })

      expect(res.status).toBe(200)
      const data = (await res.json()) as { ok: boolean }
      expect(data.ok).toBe(true)

      expect(sendNotify).toHaveBeenCalledTimes(1)
      expect(sendNotify).toHaveBeenCalledWith(
        'Drift Test',
        'Test notification from Drift',
      )
    })

    it('returns 400 when sendNotify throws', async () => {
      sendNotify.mockRejectedValueOnce(new Error('Webhook failed'))

      const res = await app.request('/api/notify/test', { method: 'POST' })

      expect(res.status).toBe(400)
      const data = (await res.json()) as { error: string }
      expect(data.error).toBe('Webhook failed')
    })
  })

  // ── GET /api/events ───────────────────────────────────

  describe('GET /api/events', () => {
    it('returns empty array when no events exist', async () => {
      const res = await app.request('/api/events')

      expect(res.status).toBe(200)
      const data = (await res.json()) as { events: unknown[] }
      expect(data.events).toEqual([])
    })

    it('returns events from event_log table', async () => {
      insertEvent(db, { type: 'cron.result', title: 'My Job' })
      insertEvent(db, { type: 'heartbeat', title: 'Heartbeat Check' })

      const res = await app.request('/api/events')

      expect(res.status).toBe(200)
      const data = (await res.json()) as { events: Array<{ type: string; title: string }> }
      expect(data.events.length).toBe(2)
    })

    it('filters by type query parameter', async () => {
      insertEvent(db, { type: 'cron.result', title: 'Cron 1' })
      insertEvent(db, { type: 'heartbeat', title: 'HB 1' })
      insertEvent(db, { type: 'cron.result', title: 'Cron 2' })

      const res = await app.request('/api/events?type=cron.result')

      expect(res.status).toBe(200)
      const data = (await res.json()) as { events: Array<{ type: string }> }
      expect(data.events.length).toBe(2)
      expect(data.events.every(e => e.type === 'cron.result')).toBe(true)
    })

    it('respects limit query parameter', async () => {
      for (let i = 0; i < 5; i++) {
        insertEvent(db, { title: `Event ${i}` })
      }

      const res = await app.request('/api/events?limit=2')

      expect(res.status).toBe(200)
      const data = (await res.json()) as { events: unknown[] }
      expect(data.events.length).toBe(2)
    })
  })

  // ── GET /api/notifications/history ────────────────────

  describe('GET /api/notifications/history', () => {
    it('returns empty array when no notifications exist', async () => {
      const res = await app.request('/api/notifications/history')

      expect(res.status).toBe(200)
      const data = (await res.json()) as { notifications: unknown[] }
      expect(data.notifications).toEqual([])
    })

    it('returns notifications from notification_log table', async () => {
      logNotification(db, {
        channel: 'feishu',
        eventType: 'chat.complete',
        title: 'Chat Done',
        status: 'success',
      })
      logNotification(db, {
        channel: 'feishu',
        eventType: 'cron.result',
        title: 'Cron Ran',
        status: 'failed',
        errorMsg: 'timeout',
      })

      const res = await app.request('/api/notifications/history')

      expect(res.status).toBe(200)
      const data = (await res.json()) as {
        notifications: Array<{ channel: string; status: string }>
      }
      expect(data.notifications.length).toBe(2)
    })

    it('respects limit query parameter', async () => {
      for (let i = 0; i < 5; i++) {
        logNotification(db, {
          channel: 'feishu',
          eventType: 'test',
          title: `Notif ${i}`,
          status: 'success',
        })
      }

      const res = await app.request('/api/notifications/history?limit=3')

      expect(res.status).toBe(200)
      const data = (await res.json()) as { notifications: unknown[] }
      expect(data.notifications.length).toBe(3)
    })
  })
})
