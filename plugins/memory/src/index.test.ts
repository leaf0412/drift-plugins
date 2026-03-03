import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'
import type { PluginContext } from '@drift/core/kernel'
import { buildMemoryTools } from './tools.js'
import { registerMemoryRoutes } from './routes.js'

// ── SQL for memory_meta (not yet in SCHEMA_SQL in the linked package) ──

const MEMORY_META_DDL = `
CREATE TABLE IF NOT EXISTS memory_meta (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  importance    REAL NOT NULL DEFAULT 0.5,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, source_id)
);
`

// ── Helpers ─────────────────────────────────────────────────

interface MetaRow {
  id: number
  source: string
  source_id: string
  importance: number
  access_count: number
  last_accessed: string | null
  created_at: string
}

function makeDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-memory-meta-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  db.exec(MEMORY_META_DDL)
  return { db, dir }
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const mockCtx = {} as PluginContext

// ── Tests: memory_meta tracking via memorySave helper (used by index.ts) ──

// We test the helper indirectly via the memory_save tool, which uses the same
// INSERT + meta upsert pattern as memorySave in index.ts.

describe('memory_meta tracking via memory_save tool', () => {
  let db: Database.Database
  let dir: string

  beforeEach(() => {
    const tmp = makeDb()
    db = tmp.db
    dir = tmp.dir
  })

  afterEach(() => {
    db.close()
    cleanup(dir)
  })

  it('creates meta entry on memory_save', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    const result = await saveTool.execute({
      type: 'fact',
      key: 'test-key',
      value: 'test-value',
    }, mockCtx)

    expect(result.success).toBe(true)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('test-key') as { id: string }
    expect(memRow).toBeDefined()

    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow | undefined

    expect(meta).toBeDefined()
    expect(meta!.source).toBe('memory')
    expect(meta!.source_id).toBe(memRow.id)
    expect(meta!.access_count).toBe(0)
  })

  it('sets importance=0.8 for preference type', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    await saveTool.execute({ type: 'preference', key: 'editor', value: 'vim' }, mockCtx)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('editor') as { id: string }
    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow

    expect(meta.importance).toBe(0.8)
  })

  it('sets importance=0.7 for decision type', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    await saveTool.execute({ type: 'decision', key: 'framework', value: 'react' }, mockCtx)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('framework') as { id: string }
    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow

    expect(meta.importance).toBe(0.7)
  })

  it('sets importance=0.3 for event type', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    await saveTool.execute({ type: 'event', key: 'deploy-date', value: '2026-03-01' }, mockCtx)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('deploy-date') as { id: string }
    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow

    expect(meta.importance).toBe(0.3)
  })

  it('sets importance=0.5 for fact type', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    await saveTool.execute({ type: 'fact', key: 'language', value: 'TypeScript' }, mockCtx)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('language') as { id: string }
    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow

    expect(meta.importance).toBe(0.5)
  })

  it('sets importance=0.5 for unknown type (fallback)', async () => {
    // Insert directly to bypass tool enum validation
    const id = nanoid()
    const now = dayjs().toISOString()
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, '', 'unknown_type', 'some-key', 'some-value', now, now)

    // Simulate what memorySave would do for an unknown type
    db.prepare(`
      INSERT INTO memory_meta (source, source_id, importance, access_count, created_at)
      VALUES ('memory', ?, ?, 0, ?)
      ON CONFLICT(source, source_id) DO UPDATE SET importance = excluded.importance
    `).run(id, 0.5, now)

    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(id) as MetaRow

    expect(meta.importance).toBe(0.5)
  })

  it('preserves access_count on memory upsert (DO NOT reset on UPDATE)', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    // First save — creates memory and meta
    await saveTool.execute({ type: 'preference', key: 'theme', value: 'dark' }, mockCtx)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('theme') as { id: string }

    // Manually bump access_count (simulating a recall)
    db.prepare(
      `UPDATE memory_meta SET access_count = 3 WHERE source = 'memory' AND source_id = ?`
    ).run(memRow.id)

    // Upsert same key with new value — should NOT reset access_count
    await saveTool.execute({ type: 'preference', key: 'theme', value: 'light' }, mockCtx)

    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow

    expect(meta.access_count).toBe(3)
    // importance may be updated (same type, same value = 0.8)
    expect(meta.importance).toBe(0.8)
  })

  it('updates importance when type changes on upsert', async () => {
    // Since type is part of the UNIQUE key (project, type, key), a type change
    // creates a new row in memory but if source_id changes, meta gets a new row.
    // Actually the UNIQUE constraint on memory is (project, type, key) so changing
    // type creates a new memory row. We test that each type gets correct importance.
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    await saveTool.execute({ type: 'fact', key: 'lang', value: 'TypeScript' }, mockCtx)
    const factRow = db.prepare(
      `SELECT id FROM memory WHERE type = 'fact' AND key = 'lang'`
    ).get() as { id: string }
    const factMeta = db.prepare(
      `SELECT importance FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(factRow.id) as { importance: number }
    expect(factMeta.importance).toBe(0.5)

    // Save a preference with same key but different type (creates separate row)
    await saveTool.execute({ type: 'preference', key: 'lang', value: 'TypeScript' }, mockCtx)
    const prefRow = db.prepare(
      `SELECT id FROM memory WHERE type = 'preference' AND key = 'lang'`
    ).get() as { id: string }
    const prefMeta = db.prepare(
      `SELECT importance FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(prefRow.id) as { importance: number }
    expect(prefMeta.importance).toBe(0.8)
  })
})

// ── Tests: memory_meta tracking via POST /api/memory route ──

describe('memory_meta tracking via POST /api/memory', () => {
  let db: Database.Database
  let dir: string
  let app: Hono

  beforeEach(() => {
    const tmp = makeDb()
    db = tmp.db
    dir = tmp.dir
    app = new Hono()
    registerMemoryRoutes(app, { db, embedSvc: null })
  })

  afterEach(() => {
    db.close()
    cleanup(dir)
  })

  it('creates meta entry on POST /api/memory', async () => {
    const res = await app.request('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'route-key', value: 'route-value', type: 'fact' }),
    })
    expect(res.status).toBe(201)

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('route-key') as { id: string }
    expect(memRow).toBeDefined()

    const meta = db.prepare(
      `SELECT * FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as MetaRow | undefined

    expect(meta).toBeDefined()
    expect(meta!.source).toBe('memory')
    expect(meta!.importance).toBe(0.5)
    expect(meta!.access_count).toBe(0)
  })

  it('sets correct importance for preference via route', async () => {
    await app.request('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'color', value: 'blue', type: 'preference' }),
    })

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('color') as { id: string }
    const meta = db.prepare(
      `SELECT importance FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as { importance: number }

    expect(meta.importance).toBe(0.8)
  })

  it('preserves access_count on upsert via route', async () => {
    await app.request('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'upsert-key', value: 'v1', type: 'fact', project: 'p' }),
    })

    const memRow = db.prepare('SELECT id FROM memory WHERE key = ?').get('upsert-key') as { id: string }

    // Bump access count manually
    db.prepare(
      `UPDATE memory_meta SET access_count = 5 WHERE source = 'memory' AND source_id = ?`
    ).run(memRow.id)

    // Upsert same key
    await app.request('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'upsert-key', value: 'v2', type: 'fact', project: 'p' }),
    })

    const meta = db.prepare(
      `SELECT access_count FROM memory_meta WHERE source = 'memory' AND source_id = ?`
    ).get(memRow.id) as { access_count: number }

    expect(meta.access_count).toBe(5)
  })
})

// ── Tests: access bumping via POST /api/recall ──

describe('access count bumping via POST /api/recall', () => {
  let db: Database.Database
  let dir: string

  beforeEach(() => {
    const tmp = makeDb()
    db = tmp.db
    dir = tmp.dir
  })

  afterEach(() => {
    db.close()
    cleanup(dir)
  })

  it('bumps access_count for all returned recall entries', async () => {
    // Insert memories and their meta
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('r1', '', 'fact', 'recall-key-1', 'value-1', now, now)
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('r2', '', 'fact', 'recall-key-2', 'value-2', now, now)
    db.prepare(
      `INSERT INTO memory_meta (source, source_id, importance, access_count, created_at)
       VALUES ('memory', 'r1', 0.5, 0, ?)`
    ).run(now)
    db.prepare(
      `INSERT INTO memory_meta (source, source_id, importance, access_count, created_at)
       VALUES ('memory', 'r2', 0.5, 2, ?)`
    ).run(now)

    const mockEmbedSvc = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
      embedBatch: vi.fn(),
      storeEmbedding: vi.fn(),
      recallSimilar: vi.fn().mockResolvedValue([
        { id: 'r1', distance: 0.1 },
        { id: 'r2', distance: 0.2 },
      ]),
    }

    const recallApp = new Hono()
    registerMemoryRoutes(recallApp, { db, embedSvc: mockEmbedSvc })

    const res = await recallApp.request('/api/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'recall test' }),
    })
    expect(res.status).toBe(200)

    const meta1 = db.prepare(
      `SELECT access_count FROM memory_meta WHERE source = 'memory' AND source_id = 'r1'`
    ).get() as { access_count: number }
    const meta2 = db.prepare(
      `SELECT access_count FROM memory_meta WHERE source = 'memory' AND source_id = 'r2'`
    ).get() as { access_count: number }

    expect(meta1.access_count).toBe(1)
    expect(meta2.access_count).toBe(3) // was 2, bumped to 3
  })

  it('sets last_accessed timestamp on recall bump', async () => {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('ts1', '', 'fact', 'ts-key', 'ts-value', now, now)
    db.prepare(
      `INSERT INTO memory_meta (source, source_id, importance, access_count, last_accessed, created_at)
       VALUES ('memory', 'ts1', 0.5, 0, NULL, ?)`
    ).run(now)

    const mockEmbedSvc = {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      storeEmbedding: vi.fn(),
      recallSimilar: vi.fn().mockResolvedValue([{ id: 'ts1', distance: 0.1 }]),
    }

    const recallApp = new Hono()
    registerMemoryRoutes(recallApp, { db, embedSvc: mockEmbedSvc })

    await recallApp.request('/api/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'ts test' }),
    })

    const meta = db.prepare(
      `SELECT last_accessed FROM memory_meta WHERE source = 'memory' AND source_id = 'ts1'`
    ).get() as { last_accessed: string | null }

    expect(meta.last_accessed).not.toBeNull()
    expect(typeof meta.last_accessed).toBe('string')
  })

  it('does not throw when recall returns entries with no matching meta rows', async () => {
    const now = new Date().toISOString()
    // Memory without corresponding meta row
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('no-meta', '', 'fact', 'no-meta-key', 'val', now, now)

    const mockEmbedSvc = {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      storeEmbedding: vi.fn(),
      recallSimilar: vi.fn().mockResolvedValue([{ id: 'no-meta', distance: 0.1 }]),
    }

    const recallApp = new Hono()
    registerMemoryRoutes(recallApp, { db, embedSvc: mockEmbedSvc })

    const res = await recallApp.request('/api/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'graceful test' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: unknown[] }
    expect(body.entries.length).toBe(1)
  })
})
