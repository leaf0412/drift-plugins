import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  SCHEMA_SQL,
  runMigrations,
  ensureSession,
  storeMessage,
  getSession,
  listSessions,
  deleteSession,
  updateSessionFolders,
  updateMessage,
  deleteMessage,
  truncateMessages,
  unifiedSearch,
} from '@drift/plugins'
import { createSessionApiPlugin } from './index.js'

// ── Helpers ─────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'test.db'))
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  return db
}

// ── Tests ──────────────────────────────────────────────────

describe('session-api plugin', () => {
  it('has correct name', () => {
    const plugin = createSessionApiPlugin()
    expect(plugin.name).toBe('session-api')
  })
})

describe('session-api routes', () => {
  let tmpDir: string
  let db: Database.Database
  let app: Hono

  beforeEach(async () => {
    tmpDir = makeTmpDir('drift-session-api-')
    db = makeDb(tmpDir)
    app = new Hono()

    // Register routes directly for testing
    app.get('/api/sessions', (c) => {
      const source = c.req.query('source')
      const channel = c.req.query('channel')
      const userId = c.req.query('userId')
      const sessions = listSessions(db, source, channel, userId)
      return c.json({ sessions })
    })
    app.get('/api/sessions/:id', (c) => {
      const id = c.req.param('id')
      const session = getSession(db, id)
      if (!session) return c.json({ error: 'Session not found' }, 404)
      return c.json(session)
    })
    app.delete('/api/sessions/:id', (c) => {
      const id = c.req.param('id')
      const deleted = deleteSession(db, id)
      if (!deleted) return c.json({ error: 'Session not found' }, 404)
      return c.json({ ok: true })
    })
    app.put('/api/sessions/:id/folders', async (c) => {
      const id = c.req.param('id')
      const body = await c.req.json<{ folders: Array<{ name: string; fileCount?: number; syncedAt?: string }> }>()
      if (!Array.isArray(body.folders)) return c.json({ error: 'folders array is required' }, 400)
      const ok = updateSessionFolders(db, id, body.folders)
      if (!ok) return c.json({ error: 'Session not found' }, 404)
      return c.json({ ok: true })
    })
    app.put('/api/sessions/:sessionId/messages/:messageId', async (c) => {
      const sessionId = c.req.param('sessionId')
      const messageId = c.req.param('messageId')
      const body = await c.req.json<{ content: string }>()
      if (!body.content && body.content !== '') return c.json({ error: 'content is required' }, 400)
      const ok = updateMessage(db, sessionId, messageId, body.content)
      if (!ok) return c.json({ error: 'Message not found' }, 404)
      return c.json({ ok: true })
    })
    app.delete('/api/sessions/:sessionId/messages/:messageId', (c) => {
      const sessionId = c.req.param('sessionId')
      const messageId = c.req.param('messageId')
      const ok = deleteMessage(db, sessionId, messageId)
      if (!ok) return c.json({ error: 'Message not found' }, 404)
      return c.json({ ok: true })
    })
    app.post('/api/sessions/:sessionId/messages/truncate', async (c) => {
      const sessionId = c.req.param('sessionId')
      const body = await c.req.json<{ keepCount: number; updateLast?: string }>()
      const { keepCount, updateLast } = body
      if (typeof keepCount !== 'number' || keepCount < 0) return c.json({ error: 'keepCount must be a non-negative number' }, 400)
      const deleted = truncateMessages(db, sessionId, keepCount, updateLast)
      return c.json({ ok: true, deleted })
    })
    app.get('/api/search', (c) => {
      const q = c.req.query('q')
      if (!q) return c.json({ error: 'q parameter required' }, 400)
      const scope = c.req.query('scope') || 'mind,chat'
      const limit = Number(c.req.query('limit')) || 20
      const scopes = scope.split(',')
      const results = unifiedSearch(db, q, scopes, limit)
      return c.json(results)
    })
  })

  afterEach(() => {
    db.close()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  // ── Sessions ──────────────────────────────────────────

  describe('GET /api/sessions', () => {
    it('returns empty sessions array', async () => {
      const res = await app.request('/api/sessions')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: unknown[] }
      expect(body.sessions).toEqual([])
    })

    it('returns sessions after creation', async () => {
      ensureSession(db, 'sess-a', 'model')
      storeMessage(db, 'sess-a', 'user', 'hello')
      const res = await app.request('/api/sessions')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessions: Array<{ id: string; messageCount: number }> }
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0].id).toBe('sess-a')
    })

    it('filters by source query param', async () => {
      ensureSession(db, 'user-s', 'model', 'user')
      ensureSession(db, 'agent-s', 'model', 'agent')
      const res = await app.request('/api/sessions?source=agent')
      const body = (await res.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions).toHaveLength(1)
      expect(body.sessions[0].id).toBe('agent-s')
    })

    it('filters by channel prefix', async () => {
      ensureSession(db, 'web:owner:s1', 'model')
      ensureSession(db, 'web:owner:s2', 'model')
      ensureSession(db, 'telegram:u1:s3', 'model')
      const res = await app.request('/api/sessions?source=all&channel=web')
      const body = (await res.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions).toHaveLength(2)
      expect(body.sessions.map((s) => s.id).sort()).toEqual(['web:owner:s1', 'web:owner:s2'])
    })

    it('filters by userId', async () => {
      ensureSession(db, 'web:alice:s1', 'model')
      ensureSession(db, 'telegram:alice:s2', 'model')
      ensureSession(db, 'web:bob:s3', 'model')
      const res = await app.request('/api/sessions?source=all&userId=alice')
      const body = (await res.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions).toHaveLength(2)
      expect(body.sessions.map((s) => s.id).sort()).toEqual(['telegram:alice:s2', 'web:alice:s1'])
    })
  })

  describe('GET /api/sessions/:id', () => {
    it('returns session with messages', async () => {
      ensureSession(db, 'detailed', 'claude')
      storeMessage(db, 'detailed', 'user', 'msg1')
      storeMessage(db, 'detailed', 'assistant', 'msg2')
      const res = await app.request('/api/sessions/detailed')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string; messages: Array<{ content: string }> }
      expect(body.id).toBe('detailed')
      expect(body.messages).toHaveLength(2)
    })

    it('returns 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/sessions/:id', () => {
    it('deletes session and returns ok', async () => {
      ensureSession(db, 'del-me', 'model')
      const res = await app.request('/api/sessions/del-me', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const check = await app.request('/api/sessions/del-me')
      expect(check.status).toBe(404)
    })

    it('returns 404 for non-existent session', async () => {
      const res = await app.request('/api/sessions/nope', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /api/sessions/:id/folders', () => {
    it('updates session folders', async () => {
      ensureSession(db, 'fold', 'model')
      const res = await app.request('/api/sessions/fold/folders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: [{ name: 'src', fileCount: 3 }] }),
      })
      expect(res.status).toBe(200)
    })

    it('returns 400 when folders is not an array', async () => {
      ensureSession(db, 'fold2', 'model')
      const res = await app.request('/api/sessions/fold2/folders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: 'not-array' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('PUT /api/sessions/:sid/messages/:mid', () => {
    it('updates message content', async () => {
      ensureSession(db, 'ms', 'model')
      const msgId = storeMessage(db, 'ms', 'user', 'original')
      const res = await app.request(`/api/sessions/ms/messages/${msgId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'edited' }),
      })
      expect(res.status).toBe(200)
      const session = getSession(db, 'ms')
      expect(session!.messages[0].content).toBe('edited')
    })

    it('returns 404 for non-existent message', async () => {
      ensureSession(db, 'ms2', 'model')
      const res = await app.request('/api/sessions/ms2/messages/bad-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'x' }),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/sessions/:sid/messages/:mid', () => {
    it('deletes a message', async () => {
      ensureSession(db, 'dm', 'model')
      const msgId = storeMessage(db, 'dm', 'user', 'bye')
      const res = await app.request(`/api/sessions/dm/messages/${msgId}`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const session = getSession(db, 'dm')
      expect(session!.messages).toHaveLength(0)
    })
  })

  describe('POST /api/sessions/:sid/messages/truncate', () => {
    it('truncates messages to keepCount', async () => {
      ensureSession(db, 'trunc', 'model')
      storeMessage(db, 'trunc', 'user', 'a')
      storeMessage(db, 'trunc', 'assistant', 'b')
      storeMessage(db, 'trunc', 'user', 'c')
      const res = await app.request('/api/sessions/trunc/messages/truncate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepCount: 1 }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; deleted: number }
      expect(body.deleted).toBe(2)
    })

    it('returns 400 for invalid keepCount', async () => {
      const res = await app.request('/api/sessions/x/messages/truncate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepCount: -1 }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/search', () => {
    it('returns 400 when q is missing', async () => {
      const res = await app.request('/api/search')
      expect(res.status).toBe(400)
    })

    it('returns chat search results', async () => {
      ensureSession(db, 'srch', 'model')
      storeMessage(db, 'srch', 'user', 'discussion about neural networks')
      const res = await app.request('/api/search?q=neural&scope=chat')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mind: unknown[]; chat: Array<{ sessionId: string }> }
      expect(body.chat.length).toBeGreaterThan(0)
    })
  })
})
