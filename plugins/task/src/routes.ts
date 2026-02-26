import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
} from './service.js'

/**
 * Register task CRUD HTTP routes on the given Hono app.
 *
 * Routes:
 *   GET    /api/tasks      — list with query params: status, priority, tag, limit
 *   GET    /api/tasks/:id  — get single task (404 if not found)
 *   POST   /api/tasks      — create (400 if no title)
 *   PUT    /api/tasks/:id  — update (404 if not found)
 *   DELETE /api/tasks/:id  — delete (404 if not found)
 */
export function registerTaskRoutes(app: Hono, db: Database.Database): void {
  // ── GET /api/tasks ─────────────────────────────────────────
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status')
    const priority = c.req.query('priority')
    const tag = c.req.query('tag')
    const limitStr = c.req.query('limit')
    const limit = limitStr ? parseInt(limitStr, 10) : undefined

    const tasks = listTasks(db, { status, priority, tag, limit })
    return c.json({ tasks })
  })

  // ── GET /api/tasks/:id ─────────────────────────────────────
  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id')
    const task = getTask(db, id)

    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    return c.json({ task })
  })

  // ── POST /api/tasks ────────────────────────────────────────
  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{
      title?: string
      description?: string
      status?: string
      priority?: string
      due_at?: string
      reminder_at?: string
      recurrence?: string
      tags?: string[]
    }>()

    if (!body.title) {
      return c.json({ error: 'title is required' }, 400)
    }

    const task = createTask(db, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      due_at: body.due_at,
      reminder_at: body.reminder_at,
      recurrence: body.recurrence,
      tags: body.tags,
    })

    return c.json({ task }, 201)
  })

  // ── PUT /api/tasks/:id ─────────────────────────────────────
  app.put('/api/tasks/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json<{
      title?: string
      description?: string
      status?: string
      priority?: string
      due_at?: string
      reminder_at?: string
      recurrence?: string
      tags?: string[]
    }>()

    const task = updateTask(db, id, body)

    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    return c.json({ task })
  })

  // ── DELETE /api/tasks/:id ──────────────────────────────────
  app.delete('/api/tasks/:id', (c) => {
    const id = c.req.param('id')
    const deleted = deleteTask(db, id)

    if (!deleted) {
      return c.json({ error: 'Task not found' }, 404)
    }

    return c.json({ ok: true })
  })
}
