import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import { buildTaskTools } from './tools.js'
import type { PluginContext } from '@drift/core/kernel'

// ── Helpers ─────────────────────────────────────────────────

function makeDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-task-tools-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return { db, dir }
}

const mockCtx = {} as PluginContext

// ── Tests ───────────────────────────────────────────────────

describe('buildTaskTools', () => {
  let db: Database.Database
  let dir: string

  beforeEach(() => {
    const tmp = makeDb()
    db = tmp.db
    dir = tmp.dir
  })

  afterEach(() => {
    db.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ── Structure tests ──────────────────────────────────────

  it('returns exactly 4 tool definitions', () => {
    const tools = buildTaskTools(() => db)
    expect(tools.length).toBe(4)
  })

  it('tool names are task_create, task_list, task_update, task_delete', () => {
    const tools = buildTaskTools(() => db)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['task_create', 'task_delete', 'task_list', 'task_update'])
  })

  it('each tool has name, description, parameters, and execute', () => {
    const tools = buildTaskTools(() => db)
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  // ── task_create ──────────────────────────────────────────

  it('task_create creates a task and returns JSON', async () => {
    const tools = buildTaskTools(() => db)
    const createTool = tools.find(t => t.name === 'task_create')!

    const result = await createTool.execute({
      title: 'Buy groceries',
      priority: 'high',
      tags: ['shopping'],
    }, mockCtx)

    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(parsed.title).toBe('Buy groceries')
    expect(parsed.priority).toBe('high')
    expect(parsed.tags).toEqual(['shopping'])
    expect(parsed.status).toBe('pending')
    expect(typeof parsed.id).toBe('string')

    // Verify in DB
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parsed.id) as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.title).toBe('Buy groceries')
  })

  it('task_create returns error when title is missing', async () => {
    const tools = buildTaskTools(() => db)
    const createTool = tools.find(t => t.name === 'task_create')!

    const result = await createTool.execute({}, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  // ── task_list ────────────────────────────────────────────

  it('task_list returns tasks as JSON array', async () => {
    const tools = buildTaskTools(() => db)
    const createTool = tools.find(t => t.name === 'task_create')!
    const listTool = tools.find(t => t.name === 'task_list')!

    await createTool.execute({ title: 'Task A' }, mockCtx)
    await createTool.execute({ title: 'Task B', status: 'done' }, mockCtx)

    const result = await listTool.execute({}, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(2)
  })

  it('task_list filters by status', async () => {
    const tools = buildTaskTools(() => db)
    const createTool = tools.find(t => t.name === 'task_create')!
    const updateTool = tools.find(t => t.name === 'task_update')!
    const listTool = tools.find(t => t.name === 'task_list')!

    await createTool.execute({ title: 'Pending one' }, mockCtx)
    const doneResult = await createTool.execute({ title: 'Done one' }, mockCtx)
    const doneTask = JSON.parse(doneResult.output)
    await updateTool.execute({ id: doneTask.id, status: 'done' }, mockCtx)

    const result = await listTool.execute({ status: 'pending' }, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(parsed.length).toBe(1)
    expect(parsed[0].title).toBe('Pending one')
  })

  // ── task_update ──────────────────────────────────────────

  it('task_update changes status and returns updated task', async () => {
    const tools = buildTaskTools(() => db)
    const createTool = tools.find(t => t.name === 'task_create')!
    const updateTool = tools.find(t => t.name === 'task_update')!

    const createResult = await createTool.execute({ title: 'Do stuff' }, mockCtx)
    const created = JSON.parse(createResult.output)

    const result = await updateTool.execute({ id: created.id, status: 'done' }, mockCtx)
    expect(result.success).toBe(true)

    const updated = JSON.parse(result.output)
    expect(updated.status).toBe('done')
    expect(updated.title).toBe('Do stuff')
  })

  it('task_update returns error for non-existent task', async () => {
    const tools = buildTaskTools(() => db)
    const updateTool = tools.find(t => t.name === 'task_update')!

    const result = await updateTool.execute({ id: 'non-existent', status: 'done' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('task_update returns error when id is missing', async () => {
    const tools = buildTaskTools(() => db)
    const updateTool = tools.find(t => t.name === 'task_update')!

    const result = await updateTool.execute({ status: 'done' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  // ── task_delete ──────────────────────────────────────────

  it('task_delete removes task and returns success', async () => {
    const tools = buildTaskTools(() => db)
    const createTool = tools.find(t => t.name === 'task_create')!
    const deleteTool = tools.find(t => t.name === 'task_delete')!

    const createResult = await createTool.execute({ title: 'Delete me' }, mockCtx)
    const created = JSON.parse(createResult.output)

    const result = await deleteTool.execute({ id: created.id }, mockCtx)
    expect(result.success).toBe(true)
    expect(result.output).toBe('Deleted')

    // Verify removed from DB
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(created.id)
    expect(row).toBeUndefined()
  })

  it('task_delete returns error for non-existent task', async () => {
    const tools = buildTaskTools(() => db)
    const deleteTool = tools.find(t => t.name === 'task_delete')!

    const result = await deleteTool.execute({ id: 'non-existent' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})
