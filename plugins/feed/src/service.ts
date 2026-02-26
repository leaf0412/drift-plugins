import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(utc)

// ── Types ─────────────────────────────────────────────────

export interface Subscription {
  id: string
  url: string
  type: string
  title: string | null
  cron: string
  last_fetched_at: string | null
  last_content_hash: string | null
  enabled: number
  created_at: string
}

export interface SubscribeInput {
  url: string
  type: 'rss' | 'webpage' | 'api'
  title?: string
  cron?: string
}

// ── CRUD ─────────────────────────────────────────────────

/**
 * Subscribe to a feed URL. Upserts by URL — if the URL already exists,
 * updates title, type, and cron instead of inserting a duplicate.
 */
export function subscribe(
  db: Database.Database,
  input: SubscribeInput,
): Subscription {
  const id = nanoid()

  db.prepare(
    `INSERT INTO subscriptions (id, url, type, title, cron)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       type  = excluded.type,
       cron  = excluded.cron`,
  ).run(
    id,
    input.url,
    input.type,
    input.title ?? null,
    input.cron ?? '0 8 * * *',
  )

  // Return the actual row (may be the existing one on conflict)
  return db.prepare(
    'SELECT * FROM subscriptions WHERE url = ?',
  ).get(input.url) as Subscription
}

/**
 * Unsubscribe by subscription id.
 * Returns true if a row was deleted, false otherwise.
 */
export function unsubscribe(
  db: Database.Database,
  id: string,
): boolean {
  const result = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
  return result.changes > 0
}

/**
 * Get a single subscription by id. Returns null if not found.
 */
export function getSubscription(
  db: Database.Database,
  id: string,
): Subscription | null {
  const row = db.prepare(
    'SELECT * FROM subscriptions WHERE id = ?',
  ).get(id) as Subscription | undefined
  return row ?? null
}

/**
 * List subscriptions, optionally filtering by enabled status.
 */
export function listSubscriptions(
  db: Database.Database,
  filter?: { enabled?: boolean },
): Subscription[] {
  if (filter?.enabled !== undefined) {
    return db.prepare(
      'SELECT * FROM subscriptions WHERE enabled = ? ORDER BY created_at DESC',
    ).all(filter.enabled ? 1 : 0) as Subscription[]
  }
  return db.prepare(
    'SELECT * FROM subscriptions ORDER BY created_at DESC',
  ).all() as Subscription[]
}

/**
 * Update fetch state after a successful poll.
 * Sets last_content_hash and last_fetched_at to now (UTC).
 */
export function updateFetchState(
  db: Database.Database,
  id: string,
  contentHash: string,
): void {
  db.prepare(
    `UPDATE subscriptions
     SET last_content_hash = ?, last_fetched_at = ?
     WHERE id = ?`,
  ).run(contentHash, dayjs.utc().toISOString(), id)
}
