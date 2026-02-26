import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { listNotifications } from './notification-log.js'
import { listEvents } from './event-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotifyRouteDeps {
  db: Database.Database
  sendNotify: (title: string, body: string, channel?: string) => Promise<void>
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
    const refId = c.req.query('refId') || undefined
    const days = c.req.query('days') ? Number(c.req.query('days')) : undefined
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50
    const events = listEvents(db, { type, refId, days, limit })
    return c.json({ events })
  })

  // ── GET /api/notifications/history ──────────────────────
  app.get('/api/notifications/history', (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50
    const notifications = listNotifications(db, limit)
    return c.json({ notifications })
  })
}
