import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { GitLabEventTracker } from './event-tracker.js'

describe('GitLabEventTracker', () => {
  let db: Database.Database
  let tracker: GitLabEventTracker

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE gitlab_event_state (
        event_key TEXT PRIMARY KEY, event_type TEXT NOT NULL, project_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'new', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
        notified_at TEXT, notify_count INTEGER DEFAULT 0, payload TEXT, resolved_at TEXT
      )
    `)
    tracker = new GitLabEventTracker(db)
  })

  it('returns new events on first poll', () => {
    const changes = tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1, status: 'failed', ref: 'main' } },
    ])
    expect(changes.new).toHaveLength(1)
    expect(changes.new[0].key).toBe('pipeline:1')
    expect(changes.ongoing).toHaveLength(0)
    expect(changes.resolved).toHaveLength(0)
  })

  it('returns empty when same notified event seen again within threshold', () => {
    tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1, status: 'failed' } },
    ])
    tracker.markNotified('pipeline:1')

    const changes = tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1, status: 'failed' } },
    ])
    expect(changes.new).toHaveLength(0)
    expect(changes.ongoing).toHaveLength(0)
  })

  it('returns ongoing events after threshold exceeded', () => {
    // Insert with old notified_at
    db.prepare(`INSERT INTO gitlab_event_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'pipeline:1', 'pipeline_failed', 100, 'notified',
      '2026-03-04T00:00:00Z', '2026-03-04T00:00:00Z',
      '2026-03-04T00:00:00Z', 1, '{}', null,
    )

    const changes = tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1, status: 'failed' } },
    ], { ongoingThresholdMs: 0 }) // threshold=0 for testing

    expect(changes.ongoing).toHaveLength(1)
    expect(changes.ongoing[0].key).toBe('pipeline:1')
  })

  it('detects resolved events when they disappear from poll', () => {
    tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1, status: 'failed' } },
    ])
    tracker.markNotified('pipeline:1')

    const changes = tracker.trackEvents('pipeline_failed', 100, [])
    expect(changes.resolved).toHaveLength(1)
    expect(changes.resolved[0].key).toBe('pipeline:1')
  })

  it('does not resolve events from different project', () => {
    tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1 } },
    ])
    tracker.markNotified('pipeline:1')

    // Poll for different project — should NOT resolve project 100's events
    const changes = tracker.trackEvents('pipeline_failed', 200, [])
    expect(changes.resolved).toHaveLength(0)
  })

  it('markNotified updates status and increments count', () => {
    tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1 } },
    ])
    tracker.markNotified('pipeline:1')

    const row = db.prepare('SELECT status, notified_at, notify_count FROM gitlab_event_state WHERE event_key = ?').get('pipeline:1') as Record<string, unknown>
    expect(row.status).toBe('notified')
    expect(row.notified_at).toBeTruthy()
    expect(row.notify_count).toBe(1)

    // Mark again
    tracker.markNotified('pipeline:1')
    const row2 = db.prepare('SELECT notify_count FROM gitlab_event_state WHERE event_key = ?').get('pipeline:1') as Record<string, unknown>
    expect(row2.notify_count).toBe(2)
  })

  it('handles multiple events in one poll', () => {
    const changes = tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1 } },
      { key: 'pipeline:2', payload: { id: 2 } },
      { key: 'pipeline:3', payload: { id: 3 } },
    ])
    expect(changes.new).toHaveLength(3)
  })

  it('still-new events (never notified) remain in new category', () => {
    // First poll
    tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1 } },
    ])
    // Don't call markNotified — status is still 'new'

    // Second poll — same event should still appear as new
    const changes = tracker.trackEvents('pipeline_failed', 100, [
      { key: 'pipeline:1', payload: { id: 1 } },
    ])
    expect(changes.new).toHaveLength(1)
  })
})
