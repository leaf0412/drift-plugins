import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'
import type { EmbeddingService } from './embeddings.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryRouteDeps {
  db: Database.Database
  embedSvc?: EmbeddingService | null // null if no OpenAI config
}

interface MemoryRow {
  id: string
  project: string
  type: string
  key: string
  value: string
  created_at: string
  updated_at: string
}

interface KnowledgeRow {
  id: string
  type: string
  title: string
  content: string
  source: string | null
  tags_json: string
  created_at: string
  updated_at: string
}

interface KnowledgeEntry {
  id: string
  type: string
  title: string
  content: string
  source?: string
  tags: string[]
  relations: string[]
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToMemoryEntry(r: MemoryRow) {
  return {
    id: r.id,
    project: r.project,
    type: r.type,
    key: r.key,
    value: r.value,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToKnowledgeEntry(row: KnowledgeRow): KnowledgeEntry {
  let tags: string[] = []
  try {
    tags = JSON.parse(row.tags_json)
  } catch {
    // ignore
  }
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    source: row.source ?? undefined,
    tags,
    relations: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

/**
 * Register memory, knowledge, and recall HTTP routes on the given Hono app.
 *
 * Routes:
 *   GET    /api/memory      -- list memories with filters
 *   POST   /api/memory      -- create/upsert memory + auto-embed
 *   DELETE /api/memory/:id  -- delete memory
 *   GET    /api/knowledge   -- list knowledge entries
 *   POST   /api/knowledge   -- create knowledge entry
 *   POST   /api/recall      -- vector semantic search
 */
export function registerMemoryRoutes(app: Hono, deps: MemoryRouteDeps): void {
  const { db, embedSvc } = deps

  // ── GET /api/memory ───────────────────────────────────────
  app.get('/api/memory', (c) => {
    const project = c.req.query('project')
    const type = c.req.query('type')
    const q = c.req.query('q')
    const limit = parseInt(c.req.query('limit') ?? '50', 10)
    const offset = parseInt(c.req.query('offset') ?? '0', 10)

    let sql = `SELECT * FROM memory WHERE type != 'project_scan'`
    const conditions: string[] = []
    const params: unknown[] = []

    if (project) {
      conditions.push(`project = ?`)
      params.push(project)
    }
    if (type) {
      conditions.push(`type = ?`)
      params.push(type)
    }
    if (q) {
      conditions.push(`(key LIKE ? OR value LIKE ?)`)
      params.push(`%${q}%`, `%${q}%`)
    }

    if (conditions.length > 0) {
      sql += ` AND ${conditions.join(' AND ')}`
    }
    sql += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)

    const rows = db.prepare(sql).all(...params) as MemoryRow[]
    const entries = rows.map(rowToMemoryEntry)
    return c.json({ entries })
  })

  // ── POST /api/memory ──────────────────────────────────────
  app.post('/api/memory', async (c) => {
    const body = await c.req.json<{
      project?: string
      type?: string
      key: string
      value: string
    }>()

    if (!body.key || !body.value) {
      return c.json({ error: 'key and value are required' }, 400)
    }

    const id = nanoid()
    const now = dayjs().toISOString()
    const project = body.project ?? ''
    const type = body.type ?? 'note'

    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project, type, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(id, project, type, body.key, body.value, now, now)

    // Auto-embed for semantic search (fire and forget)
    if (embedSvc) {
      embedSvc.storeEmbedding(db, id, `${body.key}: ${body.value}`).catch(() => {})
    }

    return c.json({ id, createdAt: now }, 201)
  })

  // ── DELETE /api/memory/:id ────────────────────────────────
  app.delete('/api/memory/:id', (c) => {
    const id = c.req.param('id')
    const result = db.prepare(`DELETE FROM memory WHERE id = ?`).run(id)
    if (result.changes === 0) {
      return c.json({ error: 'Memory not found' }, 404)
    }
    return c.json({ ok: true })
  })

  // ── GET /api/knowledge ────────────────────────────────────
  app.get('/api/knowledge', (c) => {
    const query = c.req.query('q') ?? ''
    const type = c.req.query('type')
    const limit = parseInt(c.req.query('limit') ?? '50', 10)

    let sql = `SELECT * FROM knowledge`
    const conditions: string[] = []
    const params: unknown[] = []

    if (query) {
      conditions.push(`(title LIKE ? OR content LIKE ?)`)
      params.push(`%${query}%`, `%${query}%`)
    }
    if (type) {
      conditions.push(`type = ?`)
      params.push(type)
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as KnowledgeRow[]
    const entries = rows.map(rowToKnowledgeEntry)
    return c.json({ entries })
  })

  // ── POST /api/knowledge ───────────────────────────────────
  app.post('/api/knowledge', async (c) => {
    const body = await c.req.json<{
      type?: string
      title: string
      content: string
      source?: string
      tags?: string[]
    }>()

    if (!body.title || !body.content) {
      return c.json({ error: 'title and content are required' }, 400)
    }

    const id = nanoid()
    const now = dayjs().toISOString()

    db.prepare(
      `INSERT INTO knowledge (id, type, title, content, source, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      body.type ?? 'note',
      body.title,
      body.content,
      body.source ?? null,
      JSON.stringify(body.tags ?? []),
      now,
      now,
    )

    return c.json({ id, createdAt: now }, 201)
  })

  // ── POST /api/recall ──────────────────────────────────────
  app.post('/api/recall', async (c) => {
    const body = await c.req.json<{ query: string; limit?: number }>()
    if (!body.query) {
      return c.json({ error: 'query is required' }, 400)
    }

    if (!embedSvc) {
      return c.json({ entries: [], message: 'No semantic matches found (vector search may not be enabled)' })
    }

    try {
      const similar = await embedSvc.recallSimilar(db, body.query, body.limit ?? 5)

      if (similar.length === 0) {
        return c.json({ entries: [], message: 'No semantic matches found (vector search may not be enabled)' })
      }

      // Fetch full memory entries for matched IDs
      const ids = similar.map(s => s.id)
      const placeholders = ids.map(() => '?').join(', ')
      const rows = db.prepare(
        `SELECT * FROM memory WHERE id IN (${placeholders})`
      ).all(...ids) as MemoryRow[]

      const entries = rows.map(r => ({
        id: r.id,
        project: r.project,
        type: r.type,
        key: r.key,
        value: r.value,
        distance: similar.find(s => s.id === r.id)?.distance ?? 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))

      return c.json({ entries })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Recall failed' },
        500
      )
    }
  })
}
