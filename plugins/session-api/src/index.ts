import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import {
  listSessions,
  getSession,
  deleteSession,
  updateSessionFolders,
  updateMessage,
  deleteMessage,
  truncateMessages,
  unifiedSearch,
} from '@drift/plugins'

export function createSessionApiPlugin(): DriftPlugin {
  return {
    name: 'session-api',
    version: '1.1.0',
    requiresCapabilities: ['sqlite.db', 'http.app'],

    async init(ctx: PluginContext) {
      const db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      // ── GET /api/sessions ───────────────────────────────────
      app.get('/api/sessions', (c) => {
        const source = c.req.query('source')
        const channel = c.req.query('channel')
        const userId = c.req.query('userId')
        const sessions = listSessions(db, source, channel, userId)
        return c.json({ sessions })
      })

      // ── GET /api/sessions/:id ──────────────────────────────
      app.get('/api/sessions/:id', (c) => {
        const id = c.req.param('id')
        const session = getSession(db, id)
        if (!session) {
          return c.json({ error: 'Session not found' }, 404)
        }
        return c.json(session)
      })

      // ── DELETE /api/sessions/:id ───────────────────────────
      app.delete('/api/sessions/:id', (c) => {
        const id = c.req.param('id')
        const deleted = deleteSession(db, id)
        if (!deleted) {
          return c.json({ error: 'Session not found' }, 404)
        }
        return c.json({ ok: true })
      })

      // ── PUT /api/sessions/:id/folders ──────────────────────
      app.put('/api/sessions/:id/folders', async (c) => {
        const id = c.req.param('id')
        const body = await c.req.json<{
          folders: Array<{ name: string; fileCount?: number; syncedAt?: string }>
        }>()
        if (!Array.isArray(body.folders)) {
          return c.json({ error: 'folders array is required' }, 400)
        }
        const ok = updateSessionFolders(db, id, body.folders)
        if (!ok) {
          return c.json({ error: 'Session not found' }, 404)
        }
        return c.json({ ok: true })
      })

      // ── PUT /api/sessions/:sid/messages/:mid ───────────────
      app.put('/api/sessions/:sessionId/messages/:messageId', async (c) => {
        const sessionId = c.req.param('sessionId')
        const messageId = c.req.param('messageId')
        const body = await c.req.json<{ content: string }>()

        if (!body.content && body.content !== '') {
          return c.json({ error: 'content is required' }, 400)
        }

        const ok = updateMessage(db, sessionId, messageId, body.content)
        if (!ok) {
          return c.json({ error: 'Message not found' }, 404)
        }
        return c.json({ ok: true })
      })

      // ── DELETE /api/sessions/:sid/messages/:mid ────────────
      app.delete('/api/sessions/:sessionId/messages/:messageId', (c) => {
        const sessionId = c.req.param('sessionId')
        const messageId = c.req.param('messageId')

        const ok = deleteMessage(db, sessionId, messageId)
        if (!ok) {
          return c.json({ error: 'Message not found' }, 404)
        }
        return c.json({ ok: true })
      })

      // ── POST /api/sessions/:sid/messages/truncate ─────────
      app.post('/api/sessions/:sessionId/messages/truncate', async (c) => {
        const sessionId = c.req.param('sessionId')
        const body = await c.req.json<{ keepCount: number; updateLast?: string }>()
        const { keepCount, updateLast } = body

        if (typeof keepCount !== 'number' || keepCount < 0) {
          return c.json({ error: 'keepCount must be a non-negative number' }, 400)
        }

        const deleted = truncateMessages(db, sessionId, keepCount, updateLast)
        return c.json({ ok: true, deleted })
      })

      // ── GET /api/search ─────────────────────────────────────
      app.get('/api/search', (c) => {
        const q = c.req.query('q')
        if (!q) return c.json({ error: 'q parameter required' }, 400)
        const scope = c.req.query('scope') || 'mind,chat'
        const limit = Number(c.req.query('limit')) || 20
        const scopes = scope.split(',')

        const results = unifiedSearch(db, q, scopes, limit)
        return c.json(results)
      })

      ctx.logger.info('Session API plugin initialized')
    },
  }
}

export default createSessionApiPlugin
