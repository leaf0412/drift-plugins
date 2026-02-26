import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { logEvent, listEvents } from './event-log.js'

// ── Helpers ─────────────────────────────────────────────────

const EVENT_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_log (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  ref_id     TEXT,
  title      TEXT NOT NULL,
  summary    TEXT,
  status     TEXT NOT NULL DEFAULT 'ok',
  data_json  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);
CREATE INDEX IF NOT EXISTS idx_event_log_ref ON event_log(ref_id);
`

function makeTmpDb(): { db: Database.Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-event-log-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(EVENT_LOG_SCHEMA)
  return { db, dbPath }
}

function cleanupPath(dbPath: string): void {
  const dir = dirname(dbPath)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ── Tests: logEvent ─────────────────────────────────────────

describe('logEvent', () => {
  let db: Database.Database
  let dbPath: string

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    dbPath = tmp.dbPath
  })

  afterEach(() => {
    db.close()
    cleanupPath(dbPath)
  })

  it('inserts and returns a complete EventLogEntry', () => {
    const entry = logEvent(db, {
      type: 'cron.result',
      title: 'Daily backup',
      summary: 'Completed without errors',
      status: 'ok',
      data: { duration: 42 },
    })

    expect(typeof entry.id).toBe('string')
    expect(entry.id.length).toBeGreaterThan(0)
    expect(entry.type).toBe('cron.result')
    expect(entry.title).toBe('Daily backup')
    expect(entry.summary).toBe('Completed without errors')
    expect(entry.status).toBe('ok')
    expect(entry.data).toEqual({ duration: 42 })
    expect(typeof entry.createdAt).toBe('string')

    // Verify it's actually in the DB
    const row = db.prepare('SELECT * FROM event_log WHERE id = ?').get(entry.id) as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.title).toBe('Daily backup')
  })

  it('defaults status to "ok" when not provided', () => {
    const entry = logEvent(db, {
      type: 'heartbeat',
      title: 'Health check',
    })

    expect(entry.status).toBe('ok')
  })

  it('stores null for optional fields when not provided', () => {
    const entry = logEvent(db, {
      type: 'test',
      title: 'Minimal event',
    })

    expect(entry.refId).toBeNull()
    expect(entry.summary).toBeNull()
    expect(entry.data).toBeNull()
  })

  it('stores refId when provided', () => {
    const entry = logEvent(db, {
      type: 'cron.result',
      refId: 'job-123',
      title: 'Job finished',
    })

    expect(entry.refId).toBe('job-123')
  })

  it('correctly serializes and deserializes data JSON', () => {
    const complexData = {
      nested: { key: 'value' },
      array: [1, 2, 3],
      flag: true,
    }

    const entry = logEvent(db, {
      type: 'test',
      title: 'Complex data',
      data: complexData,
    })

    expect(entry.data).toEqual(complexData)
  })
})

// ── Tests: listEvents ───────────────────────────────────────

describe('listEvents', () => {
  let db: Database.Database
  let dbPath: string

  beforeEach(() => {
    const tmp = makeTmpDb()
    db = tmp.db
    dbPath = tmp.dbPath
  })

  afterEach(() => {
    db.close()
    cleanupPath(dbPath)
  })

  it('returns events in descending order by created_at', () => {
    for (let i = 0; i < 3; i++) {
      logEvent(db, { type: 'test', title: `Event ${i}` })
    }

    const events = listEvents(db)
    expect(events.length).toBe(3)
    // Most recent first
    expect(events[0].title).toBe('Event 2')
    expect(events[2].title).toBe('Event 0')
  })

  it('filters by type', () => {
    logEvent(db, { type: 'cron.result', title: 'Cron event' })
    logEvent(db, { type: 'heartbeat', title: 'Heartbeat event' })
    logEvent(db, { type: 'cron.result', title: 'Another cron' })

    const events = listEvents(db, { type: 'cron.result' })
    expect(events.length).toBe(2)
    expect(events.every((e) => e.type === 'cron.result')).toBe(true)
  })

  it('filters by comma-separated types', () => {
    logEvent(db, { type: 'cron.result', title: 'Cron' })
    logEvent(db, { type: 'heartbeat', title: 'HB' })
    logEvent(db, { type: 'notify', title: 'Notify' })

    const events = listEvents(db, { type: 'cron.result,heartbeat' })
    expect(events.length).toBe(2)
    const types = events.map((e) => e.type)
    expect(types).toContain('cron.result')
    expect(types).toContain('heartbeat')
  })

  it('filters by refId', () => {
    logEvent(db, { type: 'cron.result', refId: 'job-1', title: 'Job 1' })
    logEvent(db, { type: 'cron.result', refId: 'job-2', title: 'Job 2' })
    logEvent(db, { type: 'cron.result', refId: 'job-1', title: 'Job 1 again' })

    const events = listEvents(db, { refId: 'job-1' })
    expect(events.length).toBe(2)
    expect(events.every((e) => e.refId === 'job-1')).toBe(true)
  })

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      logEvent(db, { type: 'test', title: `Event ${i}` })
    }

    const events = listEvents(db, { limit: 3 })
    expect(events.length).toBe(3)
  })

  it('defaults limit to 50', () => {
    for (let i = 0; i < 55; i++) {
      logEvent(db, { type: 'test', title: `Event ${i}` })
    }

    const events = listEvents(db)
    expect(events.length).toBe(50)
  })

  it('returns empty array when no events exist', () => {
    const events = listEvents(db)
    expect(events).toEqual([])
  })

  it('returns proper EventLogEntry shape', () => {
    logEvent(db, {
      type: 'cron.result',
      refId: 'ref-1',
      title: 'Shape test',
      summary: 'A summary',
      status: 'error',
      data: { key: 'value' },
    })

    const events = listEvents(db)
    expect(events.length).toBe(1)

    const e = events[0]
    expect(typeof e.id).toBe('string')
    expect(e.type).toBe('cron.result')
    expect(e.refId).toBe('ref-1')
    expect(e.title).toBe('Shape test')
    expect(e.summary).toBe('A summary')
    expect(e.status).toBe('error')
    expect(e.data).toEqual({ key: 'value' })
    expect(typeof e.createdAt).toBe('string')
  })
})
