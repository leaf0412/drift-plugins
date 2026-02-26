import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import { createTask, getTask, getDueReminders } from './service.js'
import { checkReminders } from './reminder.js'

// ── Helpers ─────────────────────────────────────────────────

function makeTmpDb(): { db: Database.Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-reminder-test-'))
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

// ── Tests ───────────────────────────────────────────────────

describe('checkReminders', () => {
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

  it('emits task.reminder for due tasks', async () => {
    const emit = vi.fn()

    createTask(db, {
      title: 'Overdue task',
      description: 'Must do this',
      priority: 'high',
      reminder_at: '2020-01-01T00:00:00.000Z',
      due_at: '2020-01-02T00:00:00.000Z',
      tags: ['work'],
    })

    const count = await checkReminders(db, emit)

    expect(count).toBe(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      'task.reminder',
      expect.objectContaining({
        title: 'Overdue task',
        description: 'Must do this',
        priority: 'high',
        due_at: '2020-01-02T00:00:00.000Z',
        tags: ['work'],
      }),
    )
    // Verify id is present in payload
    const payload = emit.mock.calls[0][1] as Record<string, unknown>
    expect(typeof payload.id).toBe('string')
  })

  it('marks tasks as notified after emitting (second check finds nothing)', async () => {
    const emit = vi.fn()

    createTask(db, {
      title: 'Notify once',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })

    // First check — should emit
    const count1 = await checkReminders(db, emit)
    expect(count1).toBe(1)
    expect(emit).toHaveBeenCalledTimes(1)

    // Second check — should find nothing (already notified)
    emit.mockClear()
    const count2 = await checkReminders(db, emit)
    expect(count2).toBe(0)
    expect(emit).not.toHaveBeenCalled()

    // Verify notified_at is set in DB
    const due = getDueReminders(db)
    expect(due.length).toBe(0)
  })

  it('does NOT create next recurrence (recurrence triggers on completion, not reminder)', async () => {
    const emit = vi.fn()

    createTask(db, {
      title: 'Daily standup',
      recurrence: 'daily',
      due_at: '2020-03-01T09:00:00.000Z',
      reminder_at: '2020-03-01T08:00:00.000Z',
    })

    const count = await checkReminders(db, emit)
    expect(count).toBe(1)

    // Should NOT have created a new task — recurrence only on completion
    const allTasks = db.prepare('SELECT * FROM tasks').all() as Array<{ title: string }>
    expect(allTasks.length).toBe(1)
    expect(allTasks[0].title).toBe('Daily standup')
  })

  it('returns 0 when no tasks are due', async () => {
    const emit = vi.fn()

    // Future reminder — not due yet
    createTask(db, {
      title: 'Future task',
      reminder_at: '2099-01-01T00:00:00.000Z',
    })

    const count = await checkReminders(db, emit)
    expect(count).toBe(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('handles multiple due tasks in one pass', async () => {
    const emit = vi.fn()

    createTask(db, {
      title: 'Task A',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })
    createTask(db, {
      title: 'Task B',
      reminder_at: '2020-06-01T00:00:00.000Z',
    })
    createTask(db, {
      title: 'Task C (future)',
      reminder_at: '2099-01-01T00:00:00.000Z',
    })

    const count = await checkReminders(db, emit)
    expect(count).toBe(2)
    expect(emit).toHaveBeenCalledTimes(2)
  })
})
