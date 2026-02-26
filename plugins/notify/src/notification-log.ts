import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'

// ── Types ─────────────────────────────────────────────────

export interface NotificationLogEntry {
  id: string
  channel: string
  eventType: string
  title: string
  status: string
  errorMsg: string | null
  createdAt: string
}

interface NotificationLogRow {
  id: string
  channel: string
  event_type: string
  title: string
  status: string
  error_msg: string | null
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────

function rowToEntry(r: NotificationLogRow): NotificationLogEntry {
  return {
    id: r.id,
    channel: r.channel,
    eventType: r.event_type,
    title: r.title,
    status: r.status,
    errorMsg: r.error_msg,
    createdAt: r.created_at,
  }
}

// ── CRUD ──────────────────────────────────────────────────

export function logNotification(
  db: Database.Database,
  input: {
    channel: string
    eventType: string
    title: string
    status: 'success' | 'failed'
    errorMsg?: string
  },
): void {
  db.prepare(
    `INSERT INTO notification_log (id, channel, event_type, title, status, error_msg, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nanoid(),
    input.channel,
    input.eventType,
    input.title,
    input.status,
    input.errorMsg ?? null,
    dayjs().toISOString(),
  )
}

export function listNotifications(
  db: Database.Database,
  limit = 50,
): NotificationLogEntry[] {
  const rows = db
    .prepare(`SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as NotificationLogRow[]
  return rows.map(rowToEntry)
}
