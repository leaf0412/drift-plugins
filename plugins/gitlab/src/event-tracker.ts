// Dedup engine for GitLab polling events

import type Database from 'better-sqlite3'

export interface TrackedEvent {
  key: string                      // unique ID like "pipeline:12345"
  payload: Record<string, unknown> // raw event data snapshot
}

export interface EventChanges {
  new: TrackedEvent[]
  ongoing: TrackedEvent[]
  resolved: TrackedEvent[]
}

export interface TrackOptions {
  ongoingThresholdMs?: number  // default 2 hours (7200000ms)
}

interface EventStateRow {
  event_key: string
  event_type: string
  project_id: number
  status: string
  first_seen: string
  last_seen: string
  notified_at: string | null
  notify_count: number
  payload: string | null
  resolved_at: string | null
}

const DEFAULT_ONGOING_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2 hours

export class GitLabEventTracker {
  constructor(private db: Database.Database) {}

  /**
   * Compare current poll results against stored state.
   * Returns categorized event changes: new, ongoing, resolved.
   */
  trackEvents(
    eventType: string,
    projectId: number,
    currentEvents: TrackedEvent[],
    opts?: TrackOptions,
  ): EventChanges {
    const threshold = opts?.ongoingThresholdMs ?? DEFAULT_ONGOING_THRESHOLD_MS
    const now = new Date().toISOString()

    const result: EventChanges = { new: [], ongoing: [], resolved: [] }
    const currentKeySet = new Set(currentEvents.map(e => e.key))

    // --- Process each current event ---
    for (const event of currentEvents) {
      const row = this.db.prepare(
        'SELECT * FROM gitlab_event_state WHERE event_key = ?',
      ).get(event.key) as EventStateRow | undefined

      if (!row) {
        // Brand new event — insert and mark as new
        this.db.prepare(`
          INSERT INTO gitlab_event_state
            (event_key, event_type, project_id, status, first_seen, last_seen, payload)
          VALUES (?, ?, ?, 'new', ?, ?, ?)
        `).run(event.key, eventType, projectId, now, now, JSON.stringify(event.payload))

        result.new.push(event)
      } else if (row.status === 'new') {
        // Previously seen but never notified — still new
        this.db.prepare(
          'UPDATE gitlab_event_state SET last_seen = ?, payload = ? WHERE event_key = ?',
        ).run(now, JSON.stringify(event.payload), event.key)

        result.new.push(event)
      } else if (row.status === 'notified') {
        // Already notified — check threshold
        const notifiedAt = row.notified_at ? new Date(row.notified_at).getTime() : 0
        const elapsed = Date.now() - notifiedAt

        if (elapsed > threshold) {
          // Past threshold — ongoing re-notification
          this.db.prepare(
            'UPDATE gitlab_event_state SET last_seen = ?, payload = ? WHERE event_key = ?',
          ).run(now, JSON.stringify(event.payload), event.key)

          result.ongoing.push(event)
        } else {
          // Within threshold — silent update
          this.db.prepare(
            'UPDATE gitlab_event_state SET last_seen = ?, payload = ? WHERE event_key = ?',
          ).run(now, JSON.stringify(event.payload), event.key)
        }
      } else if (row.status === 'resolved') {
        // Was resolved but reappeared — treat as new again
        this.db.prepare(`
          UPDATE gitlab_event_state
          SET status = 'new', last_seen = ?, payload = ?, resolved_at = NULL
          WHERE event_key = ?
        `).run(now, JSON.stringify(event.payload), event.key)

        result.new.push(event)
      }
    }

    // --- Detect resolved events ---
    // Only check rows matching this eventType + projectId with active status
    const activeRows = this.db.prepare(
      `SELECT * FROM gitlab_event_state
       WHERE event_type = ? AND project_id = ? AND status IN ('new', 'notified')`,
    ).all(eventType, projectId) as EventStateRow[]

    for (const row of activeRows) {
      if (!currentKeySet.has(row.event_key)) {
        this.db.prepare(`
          UPDATE gitlab_event_state
          SET status = 'resolved', resolved_at = ?, last_seen = ?
          WHERE event_key = ?
        `).run(now, now, row.event_key)

        result.resolved.push({
          key: row.event_key,
          payload: row.payload ? JSON.parse(row.payload) as Record<string, unknown> : {},
        })
      }
    }

    return result
  }

  /**
   * Mark an event as notified — called after the agent has sent a notification.
   */
  markNotified(eventKey: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE gitlab_event_state
      SET status = 'notified', notified_at = ?, notify_count = notify_count + 1
      WHERE event_key = ?
    `).run(now, eventKey)
  }
}
