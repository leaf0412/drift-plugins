import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { SCHEMA_SQL } from '@drift/plugins'
import type { PluginContext } from '@drift/core/kernel'
import { buildFeedTools } from './tools.js'

// ── Helpers ─────────────────────────────────────────────────

function makeDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'drift-feed-tools-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return { db, dir }
}

const mockCtx = {} as PluginContext

// ── Tests ───────────────────────────────────────────────────

describe('buildFeedTools', () => {
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

  it('returns exactly 3 tool definitions', () => {
    const tools = buildFeedTools(() => db)
    expect(tools.length).toBe(3)
  })

  it('tool names are feed_subscribe, feed_list, feed_unsubscribe', () => {
    const tools = buildFeedTools(() => db)
    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['feed_list', 'feed_subscribe', 'feed_unsubscribe'])
  })

  it('each tool has name, description, parameters, and execute', () => {
    const tools = buildFeedTools(() => db)
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  // ── feed_subscribe ─────────────────────────────────────────

  it('feed_subscribe creates a subscription and returns JSON', async () => {
    const tools = buildFeedTools(() => db)
    const subscribeTool = tools.find(t => t.name === 'feed_subscribe')!

    const result = await subscribeTool.execute({
      url: 'https://example.com/feed.xml',
      type: 'rss',
      title: 'Example RSS',
    }, mockCtx)

    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(parsed.url).toBe('https://example.com/feed.xml')
    expect(parsed.type).toBe('rss')
    expect(parsed.title).toBe('Example RSS')
    expect(parsed.cron).toBe('0 8 * * *')
    expect(typeof parsed.id).toBe('string')

    // Verify in DB
    const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(parsed.id) as Record<string, unknown>
    expect(row).toBeDefined()
    expect(row.url).toBe('https://example.com/feed.xml')
  })

  it('feed_subscribe returns error when url is missing', async () => {
    const tools = buildFeedTools(() => db)
    const subscribeTool = tools.find(t => t.name === 'feed_subscribe')!

    const result = await subscribeTool.execute({ type: 'rss' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('url is required')
  })

  it('feed_subscribe returns error when type is missing', async () => {
    const tools = buildFeedTools(() => db)
    const subscribeTool = tools.find(t => t.name === 'feed_subscribe')!

    const result = await subscribeTool.execute({ url: 'https://example.com' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('type is required')
  })

  // ── feed_list ──────────────────────────────────────────────

  it('feed_list returns subscriptions as JSON array', async () => {
    const tools = buildFeedTools(() => db)
    const subscribeTool = tools.find(t => t.name === 'feed_subscribe')!
    const listTool = tools.find(t => t.name === 'feed_list')!

    await subscribeTool.execute({ url: 'https://a.com/feed', type: 'rss' }, mockCtx)
    await subscribeTool.execute({ url: 'https://b.com/page', type: 'webpage' }, mockCtx)

    const result = await listTool.execute({}, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(2)
  })

  it('feed_list returns empty array when no subscriptions', async () => {
    const tools = buildFeedTools(() => db)
    const listTool = tools.find(t => t.name === 'feed_list')!

    const result = await listTool.execute({}, mockCtx)
    expect(result.success).toBe(true)

    const parsed = JSON.parse(result.output)
    expect(parsed).toEqual([])
  })

  // ── feed_unsubscribe ───────────────────────────────────────

  it('feed_unsubscribe removes subscription by id', async () => {
    const tools = buildFeedTools(() => db)
    const subscribeTool = tools.find(t => t.name === 'feed_subscribe')!
    const unsubscribeTool = tools.find(t => t.name === 'feed_unsubscribe')!

    const createResult = await subscribeTool.execute({
      url: 'https://example.com/rss',
      type: 'rss',
    }, mockCtx)
    const created = JSON.parse(createResult.output)

    const result = await unsubscribeTool.execute({ id: created.id }, mockCtx)
    expect(result.success).toBe(true)
    expect(result.output).toBe('Unsubscribed')

    // Verify removed from DB
    const row = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(created.id)
    expect(row).toBeUndefined()
  })

  it('feed_unsubscribe returns error for non-existent id', async () => {
    const tools = buildFeedTools(() => db)
    const unsubscribeTool = tools.find(t => t.name === 'feed_unsubscribe')!

    const result = await unsubscribeTool.execute({ id: 'non-existent' }, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Subscription not found')
  })

  it('feed_unsubscribe returns error when id is missing', async () => {
    const tools = buildFeedTools(() => db)
    const unsubscribeTool = tools.find(t => t.name === 'feed_unsubscribe')!

    const result = await unsubscribeTool.execute({}, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('id is required')
  })
})
