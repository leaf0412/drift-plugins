import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'

// ── Types ─────────────────────────────────────────────────

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

export interface EventLogInput {
  type: string
  refId?: string
  title: string
  summary?: string
  status?: string
  data?: Record<string, unknown>
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

// ── Helpers ───────────────────────────────────────────────

function rowToEntry(r: EventLogRow): EventLogEntry {
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

// ── CRUD ──────────────────────────────────────────────────

export function logEvent(
  db: Database.Database,
  input: EventLogInput,
): EventLogEntry {
  const id = nanoid()
  const now = dayjs().toISOString()
  db.prepare(
    `INSERT INTO event_log (id, type, ref_id, title, summary, status, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.refId ?? null,
    input.title,
    input.summary ?? null,
    input.status ?? 'ok',
    input.data ? JSON.stringify(input.data) : null,
    now,
  )
  return rowToEntry(
    db.prepare(`SELECT * FROM event_log WHERE id = ?`).get(id) as EventLogRow,
  )
}

export function listEvents(
  db: Database.Database,
  filter?: { type?: string; refId?: string; days?: number; limit?: number },
): EventLogEntry[] {
  let sql = `SELECT * FROM event_log WHERE 1=1`
  const params: unknown[] = []

  if (filter?.type) {
    const types = filter.type.split(',')
    sql += ` AND type IN (${types.map(() => '?').join(',')})`
    params.push(...types)
  }
  if (filter?.refId) {
    sql += ` AND ref_id = ?`
    params.push(filter.refId)
  }
  if (filter?.days) {
    sql += ` AND created_at >= ?`
    params.push(dayjs().subtract(filter.days, 'day').toISOString())
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`
  params.push(filter?.limit ?? 50)

  const rows = db.prepare(sql).all(...params) as EventLogRow[]
  return rows.map(rowToEntry)
}
