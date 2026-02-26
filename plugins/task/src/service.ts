import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(utc)

// ── Types ─────────────────────────────────────────────────

export interface Task {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  due_at: string | null
  reminder_at: string | null
  notified_at: string | null
  recurrence: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateTaskInput {
  title: string
  description?: string
  status?: string
  priority?: string
  due_at?: string
  reminder_at?: string
  recurrence?: string
  tags?: string[]
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: string
  priority?: string
  due_at?: string
  reminder_at?: string
  recurrence?: string
  tags?: string[]
}

export interface ListTasksFilter {
  status?: string
  priority?: string
  tag?: string
  due_before?: string
  due_after?: string
  limit?: number
}

// ── Internal row type ────────────────────────────────────

interface TaskRow {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  due_at: string | null
  reminder_at: string | null
  notified_at: string | null
  recurrence: string | null
  tags_json: string
  created_at: string
  updated_at: string
}

// ── Helpers ──────────────────────────────────────────────

function rowToTask(row: TaskRow): Task {
  let tags: string[] = []
  try {
    tags = JSON.parse(row.tags_json)
  } catch {
    // ignore malformed JSON
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    due_at: row.due_at,
    reminder_at: row.reminder_at,
    notified_at: row.notified_at,
    recurrence: row.recurrence,
    tags,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function nowISO(): string {
  return dayjs.utc().toISOString()
}

// ── Recurrence ───────────────────────────────────────────

const RECURRENCE_UNITS: Record<string, [number, dayjs.ManipulateType]> = {
  daily: [1, 'day'],
  weekly: [1, 'week'],
  monthly: [1, 'month'],
}

const VALID_RECURRENCES = new Set(Object.keys(RECURRENCE_UNITS))

// ── CRUD ─────────────────────────────────────────────────

export function createTask(
  db: Database.Database,
  input: CreateTaskInput,
): Task {
  const recurrence = input.recurrence || null
  if (recurrence && !VALID_RECURRENCES.has(recurrence)) {
    throw new Error(
      `Invalid recurrence "${recurrence}". Allowed: ${[...VALID_RECURRENCES].join(', ')}`,
    )
  }

  const id = nanoid()
  const now = nowISO()

  db.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, due_at, reminder_at, recurrence, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title,
    input.description ?? null,
    input.status ?? 'pending',
    input.priority ?? 'medium',
    input.due_at ?? null,
    input.reminder_at ?? null,
    recurrence,
    JSON.stringify(input.tags ?? []),
    now,
    now,
  )

  return rowToTask(
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow,
  )
}

export function getTask(
  db: Database.Database,
  id: string,
): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

export function listTasks(
  db: Database.Database,
  filter?: ListTasksFilter,
): Task[] {
  let sql = 'SELECT * FROM tasks WHERE 1=1'
  const params: unknown[] = []

  if (filter?.status) {
    sql += ' AND status = ?'
    params.push(filter.status)
  }
  if (filter?.priority) {
    sql += ' AND priority = ?'
    params.push(filter.priority)
  }
  if (filter?.tag) {
    const escapedTag = filter.tag.replace(/[%_\\]/g, '\\$&').replace(/"/g, '\\"')
    sql += ` AND tags_json LIKE ? ESCAPE '\\'`
    params.push(`%"${escapedTag}"%`)
  }
  if (filter?.due_before) {
    sql += ' AND due_at IS NOT NULL AND due_at < ?'
    params.push(filter.due_before)
  }
  if (filter?.due_after) {
    sql += ' AND due_at IS NOT NULL AND due_at > ?'
    params.push(filter.due_after)
  }

  sql += ' ORDER BY created_at DESC'

  if (filter?.limit) {
    sql += ' LIMIT ?'
    params.push(filter.limit)
  }

  const rows = db.prepare(sql).all(...params) as TaskRow[]
  return rows.map(rowToTask)
}

export function updateTask(
  db: Database.Database,
  id: string,
  input: UpdateTaskInput,
): Task | null {
  const recurrence = input.recurrence === undefined ? undefined : (input.recurrence || null)
  if (recurrence && !VALID_RECURRENCES.has(recurrence)) {
    throw new Error(
      `Invalid recurrence "${recurrence}". Allowed: ${[...VALID_RECURRENCES].join(', ')}`,
    )
  }

  // Fetch full row to detect status transitions
  const existingRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  if (!existingRow) return null
  const existing = rowToTask(existingRow)

  const setClauses: string[] = []
  const params: unknown[] = []

  if (input.title !== undefined) {
    setClauses.push('title = ?')
    params.push(input.title)
  }
  if (input.description !== undefined) {
    setClauses.push('description = ?')
    params.push(input.description)
  }
  if (input.status !== undefined) {
    setClauses.push('status = ?')
    params.push(input.status)
  }
  if (input.priority !== undefined) {
    setClauses.push('priority = ?')
    params.push(input.priority)
  }
  if (input.due_at !== undefined) {
    setClauses.push('due_at = ?')
    params.push(input.due_at)
  }
  if (input.reminder_at !== undefined) {
    setClauses.push('reminder_at = ?')
    params.push(input.reminder_at)
  }
  if (recurrence !== undefined) {
    setClauses.push('recurrence = ?')
    params.push(recurrence)
  }
  if (input.tags !== undefined) {
    setClauses.push('tags_json = ?')
    params.push(JSON.stringify(input.tags))
  }

  // Always update updated_at
  setClauses.push('updated_at = ?')
  params.push(nowISO())

  if (setClauses.length === 1) {
    // Only updated_at — still update it
  }

  const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  params.push(id)

  db.prepare(sql).run(...params)

  const updated = rowToTask(
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow,
  )

  // Trigger recurrence when task transitions to 'done'
  if (
    input.status === 'done' &&
    existing.status !== 'done' &&
    updated.recurrence
  ) {
    createNextRecurrence(db, updated)
  }

  return updated
}

export function deleteTask(
  db: Database.Database,
  id: string,
): boolean {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  return result.changes > 0
}

// ── Reminders ────────────────────────────────────────────

export function getDueReminders(db: Database.Database): Task[] {
  const now = nowISO()
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE reminder_at IS NOT NULL
         AND reminder_at <= ?
         AND notified_at IS NULL
         AND status NOT IN ('done', 'cancelled')
       ORDER BY reminder_at ASC`,
    )
    .all(now) as TaskRow[]

  return rows.map(rowToTask)
}

export function markNotified(
  db: Database.Database,
  id: string,
): void {
  db.prepare('UPDATE tasks SET notified_at = ? WHERE id = ?').run(nowISO(), id)
}

export function createNextRecurrence(
  db: Database.Database,
  task: Task,
): Task | null {
  if (!task.recurrence || !task.due_at) return null

  const unit = RECURRENCE_UNITS[task.recurrence]
  if (!unit) return null

  const [amount, type] = unit
  const nextDue = dayjs.utc(task.due_at).add(amount, type).toISOString()

  let nextReminder: string | undefined
  if (task.reminder_at) {
    nextReminder = dayjs.utc(task.reminder_at).add(amount, type).toISOString()
  }

  return createTask(db, {
    title: task.title,
    description: task.description ?? undefined,
    priority: task.priority,
    due_at: nextDue,
    reminder_at: nextReminder,
    recurrence: task.recurrence,
    tags: task.tags,
  })
}
