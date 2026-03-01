import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { getChannelUsers } from '@drift/plugins'
import { getChannelRouter } from './index.js'

/**
 * Register pairing API endpoints on the Hono app.
 *
 *   POST /api/channels/:channelId/pair  — generate a pairing code
 *   GET  /api/channels/:channelId/users — list paired users
 */
export async function registerPairingRoutes(ctx: any): Promise<void> {
  // Resolve Hono app — new-style capability call with fallback to old atoms
  let app: Hono
  if (typeof ctx.call === 'function') {
    try {
      app = await ctx.call('http.app', { pluginId: ctx.pluginId ?? 'channel' }) as Hono
    } catch {
      // fallback to atoms
      app = ctx.atoms?.atom?.('http.app', null)?.deref?.() as Hono
    }
  } else {
    app = ctx.atoms?.atom?.('http.app', null)?.deref?.() as Hono
  }
  if (!app) throw new Error('HTTP app not available for pairing routes')

  // Resolve SQLite db — new-style capability call with fallback to old atoms
  let db: Database.Database
  if (typeof ctx.call === 'function') {
    try {
      db = await ctx.call('sqlite.db') as Database.Database
    } catch {
      db = ctx.atoms?.atom?.('storage.db', null)?.deref?.() as Database.Database
    }
  } else {
    db = ctx.atoms?.atom?.('storage.db', null)?.deref?.() as Database.Database
  }
  if (!db) throw new Error('Storage db not available for pairing routes')

  // ── POST /api/channels/:channelId/pair ─────────────────────
  app.post('/api/channels/:channelId/pair', (c) => {
    const channelId = c.req.param('channelId')
    const router = getChannelRouter(ctx)
    const guard = router.getAuthGuard(channelId)
    if (!guard) {
      return c.json({ error: `No auth guard for channel "${channelId}"` }, 404)
    }
    const code = guard.generatePairingCode()
    const config = router.getChannelConfig(channelId)
    const ttl = config?.auth?.pairingTTL ?? 300
    return c.json({ code, expiresIn: ttl })
  })

  // ── GET /api/channels/:channelId/users ─────────────────────
  app.get('/api/channels/:channelId/users', (c) => {
    const channelId = c.req.param('channelId')
    const users = getChannelUsers(db, channelId)
    return c.json({ users })
  })
}
