import type { PluginContext } from '@drift/core/kernel'
import type { Context, Hono } from 'hono'
import type Database from 'better-sqlite3'
import { getChannelUsers } from '@drift/plugins'
import { getChannelRouter } from './index.js'

/**
 * Register pairing API endpoints on the Hono app.
 *
 *   POST /api/channels/:channelId/pair  — generate a pairing code
 *   GET  /api/channels/:channelId/users — list paired users
 */
export async function registerPairingRoutes(ctx: PluginContext): Promise<void> {
  const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })
  const db = await ctx.call<Database.Database>('sqlite.db')

  // ── POST /api/channels/:channelId/pair ─────────────────────
  app.post('/api/channels/:channelId/pair', (c: Context) => {
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
  app.get('/api/channels/:channelId/users', (c: Context) => {
    const channelId = c.req.param('channelId')
    const users = getChannelUsers(db, channelId)
    return c.json({ users })
  })
}
