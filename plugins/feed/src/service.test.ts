import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import {
  subscribe,
  unsubscribe,
  getSubscription,
  listSubscriptions,
  updateFetchState,
} from './service.js'

// ── Helpers ─────────────────────────────────────────────────

function makeDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-feed-test-'))
  const db = new Database(join(dir, 'test.db'))
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return { db, dir }
}

// ── Tests ───────────────────────────────────────────────────

describe('feed service', () => {
  let db: Database.Database
  let dir: string

  beforeEach(() => {
    const res = makeDb()
    db = res.db
    dir = res.dir
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('subscribe creates a subscription', () => {
    const sub = subscribe(db, {
      url: 'https://example.com/feed.xml',
      type: 'rss',
      title: 'Example Feed',
    })

    expect(sub.id).toBeDefined()
    expect(sub.url).toBe('https://example.com/feed.xml')
    expect(sub.type).toBe('rss')
    expect(sub.title).toBe('Example Feed')
    expect(sub.cron).toBe('0 8 * * *')
    expect(sub.enabled).toBe(1)
    expect(sub.last_fetched_at).toBeNull()
    expect(sub.last_content_hash).toBeNull()
    expect(sub.created_at).toBeDefined()
  })

  it('subscribe deduplicates by URL (updates title on conflict)', () => {
    const sub1 = subscribe(db, {
      url: 'https://example.com/feed.xml',
      type: 'rss',
      title: 'Old Title',
    })

    const sub2 = subscribe(db, {
      url: 'https://example.com/feed.xml',
      type: 'rss',
      title: 'New Title',
      cron: '0 12 * * *',
    })

    // Same row — id preserved
    expect(sub2.id).toBe(sub1.id)
    // Title updated
    expect(sub2.title).toBe('New Title')
    // Cron updated
    expect(sub2.cron).toBe('0 12 * * *')

    // Only one row in table
    const all = listSubscriptions(db)
    expect(all).toHaveLength(1)
  })

  it('unsubscribe removes by id', () => {
    const sub = subscribe(db, {
      url: 'https://example.com/feed.xml',
      type: 'rss',
    })

    expect(unsubscribe(db, sub.id)).toBe(true)
    expect(getSubscription(db, sub.id)).toBeNull()

    // Removing a non-existent id returns false
    expect(unsubscribe(db, 'nonexistent')).toBe(false)
  })

  it('listSubscriptions filters by enabled', () => {
    subscribe(db, { url: 'https://a.com', type: 'rss' })
    const sub2 = subscribe(db, { url: 'https://b.com', type: 'webpage' })

    // Disable sub2
    db.prepare('UPDATE subscriptions SET enabled = 0 WHERE id = ?').run(sub2.id)

    const enabledOnly = listSubscriptions(db, { enabled: true })
    expect(enabledOnly).toHaveLength(1)
    expect(enabledOnly[0].url).toBe('https://a.com')

    const disabledOnly = listSubscriptions(db, { enabled: false })
    expect(disabledOnly).toHaveLength(1)
    expect(disabledOnly[0].url).toBe('https://b.com')

    // No filter returns all
    const all = listSubscriptions(db)
    expect(all).toHaveLength(2)
  })

  it('updateFetchState updates hash and timestamp', () => {
    const sub = subscribe(db, {
      url: 'https://example.com/feed.xml',
      type: 'rss',
    })

    expect(sub.last_fetched_at).toBeNull()
    expect(sub.last_content_hash).toBeNull()

    updateFetchState(db, sub.id, 'abc123hash')

    const updated = getSubscription(db, sub.id)!
    expect(updated.last_content_hash).toBe('abc123hash')
    expect(updated.last_fetched_at).toBeDefined()
    expect(updated.last_fetched_at).not.toBeNull()
  })

  it('getSubscription returns null for missing id', () => {
    expect(getSubscription(db, 'nonexistent')).toBeNull()
  })
})
