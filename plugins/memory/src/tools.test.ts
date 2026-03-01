import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import type { PluginContext } from '@drift/core/kernel'
import { buildMemoryTools } from './tools.js'

// ── Helpers ─────────────────────────────────────────────────

function makeDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-memory-tools-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return { db, dir }
}

const mockCtx = {} as PluginContext

// ── Tests ───────────────────────────────────────────────────

describe('buildMemoryTools', () => {
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

  it('returns exactly 2 tool definitions', () => {
    const tools = buildMemoryTools(() => db)
    expect(tools.length).toBe(2)
  })

  it('tool names are memory_save and memory_list', () => {
    const tools = buildMemoryTools(() => db)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['memory_list', 'memory_save'])
  })

  it('each tool has name, description, parameters, and execute', () => {
    const tools = buildMemoryTools(() => db)
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  // ── memory_save execute tests ────────────────────────────

  it('memory_save upserts a memory entry', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    const result = await saveTool.execute({
      type: 'fact',
      key: 'preferred-editor',
      value: 'Neovim',
    }, mockCtx)

    expect(result.success).toBe(true)
    expect(result.output).toContain('preferred-editor')

    const row = db.prepare('SELECT * FROM memory WHERE key = ?').get('preferred-editor') as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.type).toBe('fact')
    expect(row.value).toBe('Neovim')
    expect(row.project).toBe('')
  })

  it('memory_save with project parameter', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    const result = await saveTool.execute({
      type: 'decision',
      key: 'test-framework',
      value: 'vitest',
      project: 'drift',
    }, mockCtx)

    expect(result.success).toBe(true)

    const row = db.prepare('SELECT * FROM memory WHERE key = ?').get('test-framework') as Record<string, unknown>
    expect(row.project).toBe('drift')
    expect(row.type).toBe('decision')
  })

  it('memory_save deduplicates on (project, type, key)', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    await saveTool.execute({
      type: 'preference',
      key: 'theme',
      value: 'dark',
      project: 'drift',
    }, mockCtx)

    await saveTool.execute({
      type: 'preference',
      key: 'theme',
      value: 'light',
      project: 'drift',
    }, mockCtx)

    const rows = db.prepare(
      "SELECT * FROM memory WHERE type = 'preference' AND key = 'theme' AND project = 'drift'"
    ).all() as Array<Record<string, unknown>>

    expect(rows.length).toBe(1)
    expect(rows[0].value).toBe('light')
  })

  it('memory_save returns error on invalid input', async () => {
    const tools = buildMemoryTools(() => db)
    const saveTool = tools.find(t => t.name === 'memory_save')!

    const result = await saveTool.execute({
      type: 'fact',
      key: '',
      value: 'something',
    }, mockCtx)

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  // ── memory_list execute tests ────────────────────────────

  it('memory_list returns entries', async () => {
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m1', '', 'fact', 'lang', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m2', '', 'preference', 'editor', 'vim', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')

    const tools = buildMemoryTools(() => db)
    const listTool = tools.find(t => t.name === 'memory_list')!

    const result = await listTool.execute({}, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(2)
  })

  it('memory_list filters by type', async () => {
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m1', '', 'fact', 'lang', 'TypeScript', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m2', '', 'preference', 'editor', 'vim', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')

    const tools = buildMemoryTools(() => db)
    const listTool = tools.find(t => t.name === 'memory_list')!

    const result = await listTool.execute({ type: 'fact' }, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(parsed.length).toBe(1)
    expect(parsed[0].type).toBe('fact')
  })

  it('memory_list excludes project_scan type', async () => {
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m1', '', 'project_scan', 'scan1', 'data', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    db.prepare(
      `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('m2', '', 'fact', 'k1', 'v1', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')

    const tools = buildMemoryTools(() => db)
    const listTool = tools.find(t => t.name === 'memory_list')!

    const result = await listTool.execute({}, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(parsed.length).toBe(1)
    expect(parsed[0].id).toBe('m2')
  })
})
