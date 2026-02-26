import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { AtomRegistry } from '@drift/core'
import type { PluginContext, LoggerLike, EventHandler } from '@drift/core'
import { SCHEMA_SQL } from '@drift/plugins'
import { createMemoryPlugin } from './index.js'
import { createEmbeddingService, type EmbeddingConfig } from './embeddings.js'
import { registerMemoryRoutes, type MemoryRouteDeps } from './routes.js'

// ── Helpers ─────────────────────────────────────────────────

function makeTmpDb(): { db: Database.Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-memory-test-'))
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

// ── Tests: Plugin Factory ──────────────────────────────────

describe('createMemoryPlugin', () => {
  it('returns a valid DriftPlugin with correct manifest', () => {
    const plugin = createMemoryPlugin()

    expect(plugin.manifest.name).toBe('memory')
    expect(plugin.manifest.version).toBe('1.0.0')
    expect(plugin.manifest.type).toBe('code')
    expect(plugin.manifest.depends).toEqual(['storage', 'http'])
    expect(plugin.manifest.capabilities.routes).toContain('/api/memory')
    expect(plugin.manifest.capabilities.routes).toContain('/api/knowledge')
    expect(plugin.manifest.capabilities.routes).toContain('/api/recall')
    expect(plugin.manifest.capabilities.storage).toContain('memories')
    expect(plugin.manifest.capabilities.storage).toContain('memory_vec')
    expect(plugin.manifest.capabilities.storage).toContain('knowledge_entries')
    expect(typeof plugin.init).toBe('function')
  })

  it('init() succeeds without embedding config', async () => {
    const { db, dbPath } = makeTmpDb()
    const atoms = new AtomRegistry()
    atoms.atom<Database.Database | null>('storage.db', null).reset(db)
    atoms.atom<Hono | null>('http.app', null).reset(new Hono())

    const plugin = createMemoryPlugin()
    await expect(plugin.init(createMockContext(atoms))).resolves.toBeUndefined()

    db.close()
    cleanupPath(dbPath)
  })

  it('init() succeeds with embedding config', async () => {
    const { db, dbPath } = makeTmpDb()
    const atoms = new AtomRegistry()
    atoms.atom<Database.Database | null>('storage.db', null).reset(db)
    atoms.atom<Hono | null>('http.app', null).reset(new Hono())

    const plugin = createMemoryPlugin({ apiKey: 'test-key' })
    await expect(plugin.init(createMockContext(atoms))).resolves.toBeUndefined()

    db.close()
    cleanupPath(dbPath)
  })
})

// ── Tests: Embedding Service ───────────────────────────────

describe('createEmbeddingService', () => {
  it('embed() calls OpenAI API and returns vector', async () => {
    const mockVector = Array.from({ length: 1536 }, (_, i) => i * 0.001)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ embedding: mockVector }],
      }), { status: 200 })
    )

    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    const result = await svc.embed('hello world')

    expect(result).toEqual(mockVector)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const callUrl = fetchSpy.mock.calls[0][0] as string
    expect(callUrl).toBe('https://api.openai.com/v1/embeddings')

    const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(callBody.model).toBe('text-embedding-3-small')
    expect(callBody.input).toBe('hello world')

    fetchSpy.mockRestore()
  })

  it('embed() uses custom baseURL and model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2] }],
      }), { status: 200 })
    )

    const svc = createEmbeddingService({
      apiKey: 'sk-custom',
      baseURL: 'https://custom.api.com/v1',
      model: 'custom-model',
    })
    await svc.embed('test')

    const callUrl = fetchSpy.mock.calls[0][0] as string
    expect(callUrl).toBe('https://custom.api.com/v1/embeddings')

    const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(callBody.model).toBe('custom-model')

    fetchSpy.mockRestore()
  })

  it('embed() returns null on API error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 })
    )

    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    const result = await svc.embed('hello')

    expect(result).toBeNull()
    fetchSpy.mockRestore()
  })

  it('embed() returns null on network error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('Network error')
    )

    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    const result = await svc.embed('hello')

    expect(result).toBeNull()
    fetchSpy.mockRestore()
  })

  it('embed() truncates text to 8000 chars', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [{ embedding: [0.1] }],
      }), { status: 200 })
    )

    const longText = 'a'.repeat(10000)
    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    await svc.embed(longText)

    const callBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(callBody.input.length).toBe(8000)

    fetchSpy.mockRestore()
  })

  it('embedBatch() returns vectors indexed correctly', async () => {
    const vec1 = [0.1, 0.2]
    const vec2 = [0.3, 0.4]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { embedding: vec2, index: 1 },
          { embedding: vec1, index: 0 },
        ],
      }), { status: 200 })
    )

    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    const result = await svc.embedBatch(['text1', 'text2'])

    expect(result[0]).toEqual(vec1)
    expect(result[1]).toEqual(vec2)

    fetchSpy.mockRestore()
  })

  it('embedBatch() returns nulls on failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('Network error')
    )

    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    const result = await svc.embedBatch(['a', 'b', 'c'])

    expect(result).toEqual([null, null, null])

    fetchSpy.mockRestore()
  })

  it('embedBatch() returns nulls on API error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Bad Request', { status: 400 })
    )

    const svc = createEmbeddingService({ apiKey: 'sk-test' })
    const result = await svc.embedBatch(['a', 'b'])

    expect(result).toEqual([null, null])

    fetchSpy.mockRestore()
  })
})

// ── Tests: Memory Routes ───────────────────────────────────

describe('registerMemoryRoutes', () => {
  let db: Database.Database
  let dbPath: string
  let app: Hono

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    dbPath = tmp.dbPath
    app = new Hono()
    registerMemoryRoutes(app, { db, embedSvc: null })
  })

  afterEach(() => {
    db.close()
    cleanupPath(dbPath)
  })

  // ── GET /api/memory ──────────────────────────────────────

  describe('GET /api/memory', () => {
    it('returns empty entries when no memories exist', async () => {
      const res = await app.request('/api/memory')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[] }
      expect(body.entries).toEqual([])
    })

    it('returns created memories', async () => {
      // Insert a memory directly
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', 'proj1', 'note', 'key1', 'value1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/memory')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string; key: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('m1')
      expect(body.entries[0].key).toBe('key1')
    })

    it('filters by project', async () => {
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', 'proj-a', 'note', 'k1', 'v1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m2', 'proj-b', 'note', 'k2', 'v2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/memory?project=proj-a')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('m1')
    })

    it('filters by type', async () => {
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', '', 'note', 'k1', 'v1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m2', '', 'fact', 'k2', 'v2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/memory?type=fact')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('m2')
    })

    it('filters by q (key or value search)', async () => {
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', '', 'note', 'typescript tips', 'use strict', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m2', '', 'note', 'python tips', 'use type hints', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/memory?q=typescript')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('m1')
    })

    it('excludes project_scan type', async () => {
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', '', 'project_scan', 'scan1', 'data', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m2', '', 'note', 'k1', 'v1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/memory')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('m2')
    })

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(`m${i}`, '', 'note', `k${i}`, `v${i}`, `2026-01-0${i + 1}T00:00:00Z`, `2026-01-0${i + 1}T00:00:00Z`)
      }

      const res = await app.request('/api/memory?limit=2')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[] }
      expect(body.entries.length).toBe(2)
    })

    it('respects offset parameter', async () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(`m${i}`, '', 'note', `k${i}`, `v${i}`, `2026-01-0${i + 1}T00:00:00Z`, `2026-01-0${i + 1}T00:00:00Z`)
      }

      const res = await app.request('/api/memory?limit=2&offset=3')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[] }
      expect(body.entries.length).toBe(2)
    })

    it('returns entries in camelCase format', async () => {
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', 'proj1', 'note', 'k1', 'v1', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')

      const res = await app.request('/api/memory')
      const body = (await res.json()) as {
        entries: Array<{ createdAt: string; updatedAt: string; created_at?: string }>
      }

      expect(body.entries[0].createdAt).toBe('2026-01-01T00:00:00Z')
      expect(body.entries[0].updatedAt).toBe('2026-01-02T00:00:00Z')
      expect(body.entries[0].created_at).toBeUndefined()
    })
  })

  // ── POST /api/memory ─────────────────────────────────────

  describe('POST /api/memory', () => {
    it('creates a memory entry and returns 201', async () => {
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test-key', value: 'test-value' }),
      })
      expect(res.status).toBe(201)

      const body = (await res.json()) as { id: string; createdAt: string }
      expect(typeof body.id).toBe('string')
      expect(body.id.length).toBeGreaterThan(0)
      expect(typeof body.createdAt).toBe('string')

      // Verify in DB
      const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(body.id) as Record<string, unknown>
      expect(row.key).toBe('test-key')
      expect(row.value).toBe('test-value')
      expect(row.type).toBe('note')
      expect(row.project).toBe('')
    })

    it('creates with custom project and type', async () => {
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'k1',
          value: 'v1',
          project: 'my-project',
          type: 'fact',
        }),
      })
      expect(res.status).toBe(201)

      const body = (await res.json()) as { id: string }
      const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(body.id) as Record<string, unknown>
      expect(row.project).toBe('my-project')
      expect(row.type).toBe('fact')
    })

    it('upserts on conflict (same project+type+key)', async () => {
      // Create first
      await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'k1', value: 'original', project: 'p', type: 'note' }),
      })

      // Upsert
      await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'k1', value: 'updated', project: 'p', type: 'note' }),
      })

      const rows = db.prepare("SELECT * FROM memory WHERE key = 'k1'").all() as Array<Record<string, unknown>>
      expect(rows.length).toBe(1)
      expect(rows[0].value).toBe('updated')
    })

    it('returns 400 when key is missing', async () => {
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v1' }),
      })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('key and value are required')
    })

    it('returns 400 when value is missing', async () => {
      const res = await app.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'k1' }),
      })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('key and value are required')
    })
  })

  // ── DELETE /api/memory/:id ────────────────────────────────

  describe('DELETE /api/memory/:id', () => {
    it('deletes an existing memory', async () => {
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('del-1', '', 'note', 'k1', 'v1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/memory/del-1', { method: 'DELETE' })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)

      // Verify deleted
      const row = db.prepare('SELECT * FROM memory WHERE id = ?').get('del-1')
      expect(row).toBeUndefined()
    })

    it('returns 404 for non-existent memory', async () => {
      const res = await app.request('/api/memory/nonexistent', { method: 'DELETE' })
      expect(res.status).toBe(404)

      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Memory not found')
    })
  })

  // ── GET /api/knowledge ────────────────────────────────────

  describe('GET /api/knowledge', () => {
    it('returns empty entries when no knowledge exists', async () => {
      const res = await app.request('/api/knowledge')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[] }
      expect(body.entries).toEqual([])
    })

    it('returns knowledge entries', async () => {
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('k1', 'note', 'Title 1', 'Content 1', 'src1', '["tag1"]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/knowledge')
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        entries: Array<{
          id: string; title: string; content: string
          tags: string[]; relations: string[]
          source?: string; createdAt: string; updatedAt: string
        }>
      }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('k1')
      expect(body.entries[0].title).toBe('Title 1')
      expect(body.entries[0].content).toBe('Content 1')
      expect(body.entries[0].tags).toEqual(['tag1'])
      expect(body.entries[0].relations).toEqual([])
      expect(body.entries[0].source).toBe('src1')
    })

    it('filters by q (title or content search)', async () => {
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('k1', 'note', 'TypeScript Guide', 'TS content', null, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('k2', 'note', 'Python Guide', 'Py content', null, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/knowledge?q=TypeScript')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('k1')
    })

    it('filters by type', async () => {
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('k1', 'article', 'A1', 'C1', null, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('k2', 'snippet', 'S1', 'C2', null, '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/knowledge?type=snippet')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ id: string }> }
      expect(body.entries.length).toBe(1)
      expect(body.entries[0].id).toBe('k2')
    })

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(`k${i}`, 'note', `T${i}`, `C${i}`, null, '[]', `2026-01-0${i + 1}T00:00:00Z`, `2026-01-0${i + 1}T00:00:00Z`)
      }

      const res = await app.request('/api/knowledge?limit=3')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[] }
      expect(body.entries.length).toBe(3)
    })

    it('handles invalid tags_json gracefully', async () => {
      db.prepare(
        `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('k1', 'note', 'T1', 'C1', null, 'not-valid-json', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      const res = await app.request('/api/knowledge')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: Array<{ tags: string[] }> }
      expect(body.entries[0].tags).toEqual([])
    })
  })

  // ── POST /api/knowledge ───────────────────────────────────

  describe('POST /api/knowledge', () => {
    it('creates a knowledge entry and returns 201', async () => {
      const res = await app.request('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'My Article',
          content: 'Article body content',
        }),
      })
      expect(res.status).toBe(201)

      const body = (await res.json()) as { id: string; createdAt: string }
      expect(typeof body.id).toBe('string')
      expect(body.id.length).toBeGreaterThan(0)

      // Verify in DB
      const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(body.id) as Record<string, unknown>
      expect(row.title).toBe('My Article')
      expect(row.content).toBe('Article body content')
      expect(row.type).toBe('note')
      expect(row.tags_json).toBe('[]')
    })

    it('creates with custom type, source, and tags', async () => {
      const res = await app.request('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Snippet',
          content: 'console.log("hello")',
          type: 'snippet',
          source: 'https://example.com',
          tags: ['js', 'logging'],
        }),
      })
      expect(res.status).toBe(201)

      const body = (await res.json()) as { id: string }
      const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(body.id) as Record<string, unknown>
      expect(row.type).toBe('snippet')
      expect(row.source).toBe('https://example.com')
      expect(JSON.parse(row.tags_json as string)).toEqual(['js', 'logging'])
    })

    it('returns 400 when title is missing', async () => {
      const res = await app.request('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'body only' }),
      })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('title and content are required')
    })

    it('returns 400 when content is missing', async () => {
      const res = await app.request('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'title only' }),
      })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('title and content are required')
    })
  })

  // ── POST /api/recall ──────────────────────────────────────

  describe('POST /api/recall', () => {
    it('returns empty entries with message when no embed service', async () => {
      const res = await app.request('/api/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test query' }),
      })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[]; message: string }
      expect(body.entries).toEqual([])
      expect(body.message).toContain('No semantic matches')
    })

    it('returns 400 when query is missing', async () => {
      const res = await app.request('/api/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)

      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('query is required')
    })
  })

  describe('POST /api/recall (with mock embed service)', () => {
    it('returns matching memories with distances', async () => {
      // Insert test memories
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m1', 'proj', 'note', 'typescript', 'TS is great', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      db.prepare(
        `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('m2', 'proj', 'note', 'python', 'Python is cool', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

      // Create app with mock embed service
      const mockApp = new Hono()
      const mockEmbedSvc = {
        embed: vi.fn().mockResolvedValue([0.1, 0.2]),
        embedBatch: vi.fn().mockResolvedValue([[0.1], [0.2]]),
        storeEmbedding: vi.fn().mockResolvedValue(undefined),
        recallSimilar: vi.fn().mockResolvedValue([
          { id: 'm1', distance: 0.1 },
          { id: 'm2', distance: 0.5 },
        ]),
      }
      registerMemoryRoutes(mockApp, { db, embedSvc: mockEmbedSvc })

      const res = await mockApp.request('/api/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'programming languages', limit: 10 }),
      })
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        entries: Array<{ id: string; distance: number; key: string }>
      }
      expect(body.entries.length).toBe(2)
      // Check that distance is included from the recall result
      const m1Entry = body.entries.find(e => e.id === 'm1')
      expect(m1Entry).toBeDefined()
      expect(m1Entry!.distance).toBe(0.1)
      expect(m1Entry!.key).toBe('typescript')

      // Verify recallSimilar was called with correct args
      expect(mockEmbedSvc.recallSimilar).toHaveBeenCalledWith(db, 'programming languages', 10)
    })

    it('returns empty entries when recallSimilar returns nothing', async () => {
      const mockApp = new Hono()
      const mockEmbedSvc = {
        embed: vi.fn(),
        embedBatch: vi.fn(),
        storeEmbedding: vi.fn(),
        recallSimilar: vi.fn().mockResolvedValue([]),
      }
      registerMemoryRoutes(mockApp, { db, embedSvc: mockEmbedSvc })

      const res = await mockApp.request('/api/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'no matches' }),
      })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { entries: unknown[]; message: string }
      expect(body.entries).toEqual([])
      expect(body.message).toContain('No semantic matches')
    })

    it('returns 500 when recallSimilar throws', async () => {
      const mockApp = new Hono()
      const mockEmbedSvc = {
        embed: vi.fn(),
        embedBatch: vi.fn(),
        storeEmbedding: vi.fn(),
        recallSimilar: vi.fn().mockRejectedValue(new Error('vector DB crashed')),
      }
      registerMemoryRoutes(mockApp, { db, embedSvc: mockEmbedSvc })

      const res = await mockApp.request('/api/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test' }),
      })
      expect(res.status).toBe(500)

      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('vector DB crashed')
    })
  })

  // ── POST /api/memory with embed service ───────────────────

  describe('POST /api/memory (with embed service)', () => {
    it('calls storeEmbedding on memory creation', async () => {
      const mockApp = new Hono()
      const mockEmbedSvc = {
        embed: vi.fn(),
        embedBatch: vi.fn(),
        storeEmbedding: vi.fn().mockResolvedValue(undefined),
        recallSimilar: vi.fn(),
      }
      registerMemoryRoutes(mockApp, { db, embedSvc: mockEmbedSvc })

      const res = await mockApp.request('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'embed-key', value: 'embed-value' }),
      })
      expect(res.status).toBe(201)

      // Give the fire-and-forget promise a tick to resolve
      await new Promise(r => setTimeout(r, 10))

      expect(mockEmbedSvc.storeEmbedding).toHaveBeenCalledTimes(1)
      expect(mockEmbedSvc.storeEmbedding).toHaveBeenCalledWith(
        db,
        expect.any(String),
        'embed-key: embed-value'
      )
    })
  })
})
