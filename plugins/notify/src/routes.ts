import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { listNotifications } from './notification-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventLogEntry {
  id: string
  type: string
  refId: string | null
  title: string
  summary: string | null
  status: string
  data: Record<string, unknown> | null
  createdAt: string
}

interface EventLogRow {
  id: string
  type: string
  ref_id: string | null
  title: string
  summary: string | null
  status: string
  data_json: string | null
  created_at: string
}

export interface NotifyRouteDeps {
  db: Database.Database
  sendNotify: (title: string, body: string, channel?: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEventEntry(r: EventLogRow): EventLogEntry {
  return {
    id: r.id,
    type: r.type,
    refId: r.ref_id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    data: r.data_json ? JSON.parse(r.data_json) : null,
    createdAt: r.created_at,
  }
}

function listEvents(
  db: Database.Database,
  filter?: { type?: string; limit?: number },
): EventLogEntry[] {
  let sql = `SELECT * FROM event_log WHERE 1=1`
  const params: unknown[] = []

  if (filter?.type) {
    const types = filter.type.split(',')
    sql += ` AND type IN (${types.map(() => '?').join(',')})`
    params.push(...types)
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`
  params.push(filter?.limit ?? 50)

  const rows = db.prepare(sql).all(...params) as EventLogRow[]
  return rows.map(rowToEventEntry)
}

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

/**
 * Register notification-related HTTP routes on the given Hono app.
 *
 * Routes:
 *   POST /api/notify          -- send a notification
 *   POST /api/notify/test     -- send a test notification
 *   GET  /api/events          -- query event_log table
 *   GET  /api/notifications/history -- query notification_log table
 */
export function registerNotifyRoutes(app: Hono, deps: NotifyRouteDeps): void {
  const { db, sendNotify } = deps

  // ── POST /api/notify ────────────────────────────────────
  app.post('/api/notify', async (c) => {
    let body: { title?: string; body?: string; channel?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.title || !body.body) {
      return c.json({ error: 'title and body are required' }, 400)
    }

    try {
      await sendNotify(body.title, body.body, body.channel)
      return c.json({ ok: true })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Notify failed' },
        400,
      )
    }
  })

  // ── POST /api/notify/test ───────────────────────────────
  app.post('/api/notify/test', async (c) => {
    try {
      await sendNotify('Drift Test', 'Test notification from Drift')
      return c.json({ ok: true })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Notify test failed' },
        400,
      )
    }
  })

  // ── GET /api/events ─────────────────────────────────────
  app.get('/api/events', (c) => {
    const type = c.req.query('type') || undefined
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50
    const events = listEvents(db, { type, limit })
    return c.json({ events })
  })

  // ── GET /api/notifications/history ──────────────────────
  app.get('/api/notifications/history', (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50
    const notifications = listNotifications(db, limit)
    return c.json({ notifications })
  })
}
