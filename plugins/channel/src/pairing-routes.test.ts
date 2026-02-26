import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, runMigrations, addChannelUser, getChannelUsers, createHttpApp } from '@drift/plugins'
import { ChannelRouter } from './router.js'
import { AuthGuard } from './auth.js'

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

describe('pairing routes', () => {
  let tmpDir: string
  let db: Database.Database
  let app: Hono
  let router: ChannelRouter

  beforeEach(() => {
    tmpDir = makeTmpDir('drift-pairing-api-')
    db = makeDb(tmpDir)
    app = new Hono()
    router = new ChannelRouter()

    // Register routes directly (mirrors registerPairingRoutes logic)
    app.post('/api/channels/:channelId/pair', (c) => {
      const channelId = c.req.param('channelId')
      const guard = router.getAuthGuard(channelId)
      if (!guard) {
        return c.json({ error: `No auth guard for channel "${channelId}"` }, 404)
      }
      const code = guard.generatePairingCode()
      const config = router.getChannelConfig(channelId)
      const ttl = config?.auth?.pairingTTL ?? 300
      return c.json({ code, expiresIn: ttl })
    })

    app.get('/api/channels/:channelId/users', (c) => {
      const channelId = c.req.param('channelId')
      const users = getChannelUsers(db, channelId)
      return c.json({ users })
    })
  })

  afterEach(() => {
    db.close()
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  // ── POST /api/channels/:channelId/pair ─────────────────

  describe('POST /api/channels/:channelId/pair', () => {
    it('returns 404 when channel has no auth guard', async () => {
      const res = await app.request('/api/channels/unknown/pair', { method: 'POST' })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('No auth guard')
    })

    it('generates a pairing code for a configured channel', async () => {
      router.setChannelConfig('telegram', {
        auth: { mode: 'pairing', pairingTTL: 120 },
        agent: null,
      })
      const res = await app.request('/api/channels/telegram/pair', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json() as { code: string; expiresIn: number }
      expect(body.code).toHaveLength(6)
      expect(body.expiresIn).toBe(120)
    })

    it('uses default TTL of 300 when pairingTTL is not set', async () => {
      router.setChannelConfig('feishu', {
        auth: { mode: 'pairing' },
        agent: null,
      })
      const res = await app.request('/api/channels/feishu/pair', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json() as { code: string; expiresIn: number }
      expect(body.code).toHaveLength(6)
      expect(body.expiresIn).toBe(300)
    })

    it('generates unique codes on each call', async () => {
      router.setChannelConfig('telegram', {
        auth: { mode: 'pairing' },
        agent: null,
      })
      const res1 = await app.request('/api/channels/telegram/pair', { method: 'POST' })
      const res2 = await app.request('/api/channels/telegram/pair', { method: 'POST' })
      const body1 = await res1.json() as { code: string }
      const body2 = await res2.json() as { code: string }
      expect(body1.code).not.toBe(body2.code)
    })
  })

  // ── GET /api/channels/:channelId/users ─────────────────

  describe('GET /api/channels/:channelId/users', () => {
    it('returns empty array when no users are paired', async () => {
      const res = await app.request('/api/channels/telegram/users')
      expect(res.status).toBe(200)
      const body = await res.json() as { users: string[] }
      expect(body.users).toEqual([])
    })

    it('returns paired users from the database', async () => {
      addChannelUser(db, 'telegram', 'user-123')
      addChannelUser(db, 'telegram', 'user-456')
      addChannelUser(db, 'feishu', 'user-789')

      const res = await app.request('/api/channels/telegram/users')
      expect(res.status).toBe(200)
      const body = await res.json() as { users: string[] }
      expect(body.users).toHaveLength(2)
      expect(body.users).toContain('user-123')
      expect(body.users).toContain('user-456')
    })

    it('does not return users from other channels', async () => {
      addChannelUser(db, 'feishu', 'feishu-user')

      const res = await app.request('/api/channels/telegram/users')
      expect(res.status).toBe(200)
      const body = await res.json() as { users: string[] }
      expect(body.users).toEqual([])
    })
  })

  // ── Auth middleware integration ───────────────────────

  describe('auth protection (global middleware)', () => {
    const AUTH_TOKEN = 'test-secret-token'
    let authedApp: Hono

    beforeEach(() => {
      authedApp = createHttpApp({ authToken: AUTH_TOKEN })

      authedApp.post('/api/channels/:channelId/pair', (c) => {
        const channelId = c.req.param('channelId')
        const guard = router.getAuthGuard(channelId)
        if (!guard) {
          return c.json({ error: `No auth guard for channel "${channelId}"` }, 404)
        }
        const code = guard.generatePairingCode()
        const config = router.getChannelConfig(channelId)
        const ttl = config?.auth?.pairingTTL ?? 300
        return c.json({ code, expiresIn: ttl })
      })

      authedApp.get('/api/channels/:channelId/users', (c) => {
        const channelId = c.req.param('channelId')
        const users = getChannelUsers(db, channelId)
        return c.json({ users })
      })
    })

    it('rejects POST /pair without token', async () => {
      router.setChannelConfig('telegram', { auth: { mode: 'pairing' }, agent: null })
      const res = await authedApp.request('/api/channels/telegram/pair', { method: 'POST' })
      expect(res.status).toBe(401)
    })

    it('rejects GET /users without token', async () => {
      const res = await authedApp.request('/api/channels/telegram/users')
      expect(res.status).toBe(401)
    })

    it('rejects POST /pair with wrong token', async () => {
      router.setChannelConfig('telegram', { auth: { mode: 'pairing' }, agent: null })
      const res = await authedApp.request('/api/channels/telegram/pair', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      })
      expect(res.status).toBe(401)
    })

    it('allows POST /pair with correct token', async () => {
      router.setChannelConfig('telegram', { auth: { mode: 'pairing' }, agent: null })
      const res = await authedApp.request('/api/channels/telegram/pair', {
        method: 'POST',
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { code: string }
      expect(body.code).toHaveLength(6)
    })

    it('allows GET /users with correct token', async () => {
      addChannelUser(db, 'telegram', 'user-1')
      const res = await authedApp.request('/api/channels/telegram/users', {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { users: string[] }
      expect(body.users).toContain('user-1')
    })
  })
})
