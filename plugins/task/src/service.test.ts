import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  getDueReminders,
  markNotified,
  createNextRecurrence,
} from './service.js'
import type { Task } from './service.js'

// ── Helpers ─────────────────────────────────────────────────

function makeTmpDb(): { db: Database.Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-task-test-'))
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

// ── Tests: CRUD ─────────────────────────────────────────────

describe('Task CRUD', () => {
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

  // ── createTask ──────────────────────────────────────────

  describe('createTask', () => {
    it('rejects invalid recurrence values', () => {
      expect(() => createTask(db, { title: 'Bad', recurrence: '0 9 * * *' }))
        .toThrow('Invalid recurrence "0 9 * * *"')
      expect(() => createTask(db, { title: 'Bad', recurrence: 'biweekly' }))
        .toThrow('Invalid recurrence "biweekly"')
    })

    it('accepts valid recurrence values', () => {
      for (const r of ['daily', 'weekly', 'monthly']) {
        const task = createTask(db, { title: `${r} task`, recurrence: r, due_at: '2026-03-01T00:00:00.000Z' })
        expect(task.recurrence).toBe(r)
      }
    })

    it('normalizes empty string recurrence to null', () => {
      const task = createTask(db, { title: 'Empty rec', recurrence: '' })
      expect(task.recurrence).toBeNull()
    })

    it('returns task with id and defaults', () => {
      const task = createTask(db, { title: 'Buy groceries' })

      expect(typeof task.id).toBe('string')
      expect(task.id.length).toBeGreaterThan(0)
      expect(task.title).toBe('Buy groceries')
      expect(task.description).toBeNull()
      expect(task.status).toBe('pending')
      expect(task.priority).toBe('medium')
      expect(task.due_at).toBeNull()
      expect(task.reminder_at).toBeNull()
      expect(task.notified_at).toBeNull()
      expect(task.recurrence).toBeNull()
      expect(task.tags).toEqual([])
      expect(typeof task.created_at).toBe('string')
      expect(typeof task.updated_at).toBe('string')
    })

    it('accepts all optional fields', () => {
      const task = createTask(db, {
        title: 'Deploy v2',
        description: 'Deploy new version to production',
        status: 'in_progress',
        priority: 'urgent',
        due_at: '2026-03-01T10:00:00.000Z',
        reminder_at: '2026-03-01T09:00:00.000Z',
        recurrence: 'weekly',
        tags: ['deploy', 'prod'],
      })

      expect(task.title).toBe('Deploy v2')
      expect(task.description).toBe('Deploy new version to production')
      expect(task.status).toBe('in_progress')
      expect(task.priority).toBe('urgent')
      expect(task.due_at).toBe('2026-03-01T10:00:00.000Z')
      expect(task.reminder_at).toBe('2026-03-01T09:00:00.000Z')
      expect(task.recurrence).toBe('weekly')
      expect(task.tags).toEqual(['deploy', 'prod'])
    })
  })

  // ── getTask ─────────────────────────────────────────────

  describe('getTask', () => {
    it('returns null for non-existent task', () => {
      expect(getTask(db, 'non-existent')).toBeNull()
    })

    it('returns task by id', () => {
      const created = createTask(db, { title: 'Find me' })
      const found = getTask(db, created.id)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.title).toBe('Find me')
    })
  })

  // ── listTasks ───────────────────────────────────────────

  describe('listTasks', () => {
    it('returns all tasks when no filter', () => {
      createTask(db, { title: 'Task A' })
      createTask(db, { title: 'Task B' })
      createTask(db, { title: 'Task C' })

      const tasks = listTasks(db)
      expect(tasks.length).toBe(3)
    })

    it('filters by status', () => {
      createTask(db, { title: 'Pending', status: 'pending' })
      createTask(db, { title: 'Done', status: 'done' })
      createTask(db, { title: 'Also pending', status: 'pending' })

      const tasks = listTasks(db, { status: 'pending' })
      expect(tasks.length).toBe(2)
      expect(tasks.every(t => t.status === 'pending')).toBe(true)
    })

    it('filters by priority', () => {
      createTask(db, { title: 'Low', priority: 'low' })
      createTask(db, { title: 'High', priority: 'high' })
      createTask(db, { title: 'Also high', priority: 'high' })

      const tasks = listTasks(db, { priority: 'high' })
      expect(tasks.length).toBe(2)
      expect(tasks.every(t => t.priority === 'high')).toBe(true)
    })

    it('filters by tag', () => {
      createTask(db, { title: 'Work task', tags: ['work', 'urgent'] })
      createTask(db, { title: 'Personal task', tags: ['personal'] })
      createTask(db, { title: 'Another work', tags: ['work'] })

      const tasks = listTasks(db, { tag: 'work' })
      expect(tasks.length).toBe(2)
      expect(tasks.every(t => t.tags.includes('work'))).toBe(true)
    })

    it('escapes LIKE wildcards in tag filter', () => {
      createTask(db, { title: 'Special tag', tags: ['100%_done'] })
      createTask(db, { title: 'Normal tag', tags: ['normal'] })

      const tasks = listTasks(db, { tag: '100%_done' })
      expect(tasks.length).toBe(1)
      expect(tasks[0].title).toBe('Special tag')
    })

    it('filters by due_before', () => {
      createTask(db, { title: 'Soon', due_at: '2026-02-20T00:00:00.000Z' })
      createTask(db, { title: 'Later', due_at: '2026-04-01T00:00:00.000Z' })

      const tasks = listTasks(db, { due_before: '2026-03-01T00:00:00.000Z' })
      expect(tasks.length).toBe(1)
      expect(tasks[0].title).toBe('Soon')
    })

    it('filters by due_after', () => {
      createTask(db, { title: 'Soon', due_at: '2026-02-20T00:00:00.000Z' })
      createTask(db, { title: 'Later', due_at: '2026-04-01T00:00:00.000Z' })

      const tasks = listTasks(db, { due_after: '2026-03-01T00:00:00.000Z' })
      expect(tasks.length).toBe(1)
      expect(tasks[0].title).toBe('Later')
    })

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        createTask(db, { title: `Task ${i}` })
      }

      const tasks = listTasks(db, { limit: 3 })
      expect(tasks.length).toBe(3)
    })

    it('returns empty array when no tasks match', () => {
      createTask(db, { title: 'Done', status: 'done' })
      const tasks = listTasks(db, { status: 'cancelled' })
      expect(tasks).toEqual([])
    })
  })

  // ── updateTask ──────────────────────────────────────────

  describe('updateTask', () => {
    it('updates provided fields only', () => {
      const task = createTask(db, { title: 'Original', priority: 'low' })
      const updated = updateTask(db, task.id, { title: 'Updated' })

      expect(updated).not.toBeNull()
      expect(updated!.title).toBe('Updated')
      expect(updated!.priority).toBe('low') // unchanged
    })

    it('updates tags', () => {
      const task = createTask(db, { title: 'Tagged', tags: ['old'] })
      const updated = updateTask(db, task.id, { tags: ['new', 'shiny'] })

      expect(updated!.tags).toEqual(['new', 'shiny'])
    })

    it('rejects invalid recurrence values', () => {
      const task = createTask(db, { title: 'Valid' })
      expect(() => updateTask(db, task.id, { recurrence: '0 15 * * *' }))
        .toThrow('Invalid recurrence "0 15 * * *"')
    })

    it('returns null for non-existent task', () => {
      expect(updateTask(db, 'non-existent', { title: 'Nope' })).toBeNull()
    })

    it('creates next recurrence when status transitions to done', () => {
      const task = createTask(db, {
        title: 'Daily standup',
        recurrence: 'daily',
        due_at: '2026-03-01T09:00:00.000Z',
        reminder_at: '2026-03-01T08:00:00.000Z',
      })

      const updated = updateTask(db, task.id, { status: 'done' })
      expect(updated!.status).toBe('done')

      // Should have created a new recurring task
      const allTasks = listTasks(db)
      expect(allTasks.length).toBe(2)

      const next = allTasks.find(t => t.id !== task.id)
      expect(next).toBeDefined()
      expect(next!.title).toBe('Daily standup')
      expect(next!.due_at).toBe('2026-03-02T09:00:00.000Z')
      expect(next!.reminder_at).toBe('2026-03-02T08:00:00.000Z')
      expect(next!.recurrence).toBe('daily')
      expect(next!.status).toBe('pending')
    })

    it('does not create recurrence when already done', () => {
      const task = createTask(db, {
        title: 'Already done',
        recurrence: 'daily',
        due_at: '2026-03-01T09:00:00.000Z',
        status: 'done',
      })

      // Updating a done task to done again should not create recurrence
      updateTask(db, task.id, { status: 'done' })

      const allTasks = listTasks(db)
      expect(allTasks.length).toBe(1)
    })

    it('does not create recurrence when no recurrence pattern', () => {
      const task = createTask(db, {
        title: 'One-off',
        due_at: '2026-03-01T09:00:00.000Z',
      })

      updateTask(db, task.id, { status: 'done' })

      const allTasks = listTasks(db)
      expect(allTasks.length).toBe(1)
    })

    it('updates updated_at timestamp', () => {
      const task = createTask(db, { title: 'Timestamps' })
      // Small delay to ensure different timestamp
      const updated = updateTask(db, task.id, { title: 'Changed' })

      expect(updated!.updated_at).toBeDefined()
      // updated_at should be at least as recent as created_at
      expect(updated!.updated_at >= task.created_at).toBe(true)
    })
  })

  // ── deleteTask ──────────────────────────────────────────

  describe('deleteTask', () => {
    it('deletes existing task and returns true', () => {
      const task = createTask(db, { title: 'Delete me' })
      expect(deleteTask(db, task.id)).toBe(true)
      expect(getTask(db, task.id)).toBeNull()
    })

    it('returns false for non-existent task', () => {
      expect(deleteTask(db, 'non-existent')).toBe(false)
    })
  })
})

// ── Tests: Reminders ────────────────────────────────────────

describe('Task Reminders', () => {
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

  it('getDueReminders finds past reminder_at with null notified_at', () => {
    // Past reminder, not notified → should appear
    createTask(db, {
      title: 'Overdue reminder',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })
    // Future reminder → should NOT appear
    createTask(db, {
      title: 'Future reminder',
      reminder_at: '2099-01-01T00:00:00.000Z',
    })
    // No reminder → should NOT appear
    createTask(db, { title: 'No reminder' })

    const due = getDueReminders(db)
    expect(due.length).toBe(1)
    expect(due[0].title).toBe('Overdue reminder')
  })

  it('getDueReminders skips already-notified tasks', () => {
    const task = createTask(db, {
      title: 'Already notified',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })
    markNotified(db, task.id)

    const due = getDueReminders(db)
    expect(due.length).toBe(0)
  })

  it('getDueReminders skips done and cancelled tasks', () => {
    createTask(db, {
      title: 'Done task',
      status: 'done',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })
    createTask(db, {
      title: 'Cancelled task',
      status: 'cancelled',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })

    const due = getDueReminders(db)
    expect(due.length).toBe(0)
  })

  it('markNotified sets notified_at timestamp', () => {
    const task = createTask(db, {
      title: 'Mark me',
      reminder_at: '2020-01-01T00:00:00.000Z',
    })
    expect(task.notified_at).toBeNull()

    markNotified(db, task.id)

    const updated = getTask(db, task.id)
    expect(updated!.notified_at).not.toBeNull()
    expect(typeof updated!.notified_at).toBe('string')
  })
})

// ── Tests: Recurrence ───────────────────────────────────────

describe('Task Recurrence', () => {
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

  it('createNextRecurrence for daily shifts due_at by 1 day', () => {
    const task = createTask(db, {
      title: 'Daily standup',
      recurrence: 'daily',
      due_at: '2026-03-01T09:00:00.000Z',
      status: 'done',
    })

    const next = createNextRecurrence(db, task)
    expect(next).not.toBeNull()
    expect(next!.title).toBe('Daily standup')
    expect(next!.id).not.toBe(task.id) // new task
    expect(next!.status).toBe('pending')
    expect(next!.due_at).toBe('2026-03-02T09:00:00.000Z')
    expect(next!.recurrence).toBe('daily')
  })

  it('createNextRecurrence for weekly shifts due_at by 7 days', () => {
    const task = createTask(db, {
      title: 'Weekly review',
      recurrence: 'weekly',
      due_at: '2026-03-01T09:00:00.000Z',
    })

    const next = createNextRecurrence(db, task)
    expect(next).not.toBeNull()
    expect(next!.due_at).toBe('2026-03-08T09:00:00.000Z')
  })

  it('createNextRecurrence for monthly shifts due_at by 1 month', () => {
    const task = createTask(db, {
      title: 'Monthly report',
      recurrence: 'monthly',
      due_at: '2026-03-01T09:00:00.000Z',
    })

    const next = createNextRecurrence(db, task)
    expect(next).not.toBeNull()
    expect(next!.due_at).toBe('2026-04-01T09:00:00.000Z')
  })

  it('returns null when task has no recurrence', () => {
    const task = createTask(db, { title: 'One-off task' })
    expect(createNextRecurrence(db, task)).toBeNull()
  })

  it('returns null when task has no due_at', () => {
    const task = createTask(db, {
      title: 'Recurring but no due date',
      recurrence: 'daily',
    })
    expect(createNextRecurrence(db, task)).toBeNull()
  })

  it('shifts reminder_at by the same offset as due_at', () => {
    const task = createTask(db, {
      title: 'With reminder',
      recurrence: 'daily',
      due_at: '2026-03-01T10:00:00.000Z',
      reminder_at: '2026-03-01T09:00:00.000Z',
    })

    const next = createNextRecurrence(db, task)
    expect(next).not.toBeNull()
    expect(next!.reminder_at).toBe('2026-03-02T09:00:00.000Z')
  })
})
