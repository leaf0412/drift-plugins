import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { buildGitLabTools } from './tools.js'
import type { GitLabClient } from './client.js'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE gitlab_event_state (
      event_key TEXT PRIMARY KEY, event_type TEXT NOT NULL, project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      notified_at TEXT, notify_count INTEGER DEFAULT 0, payload TEXT, resolved_at TEXT
    )
  `)
  return db
}

describe('gitlab_check_pipelines tool', () => {
  let db: Database.Database
  let mockClient: Partial<GitLabClient>

  beforeEach(() => {
    db = createTestDb()
    mockClient = {
      listPipelines: vi.fn().mockResolvedValue([
        { id: 1, iid: 1, status: 'failed', ref: 'main', sha: 'abc', web_url: 'https://gl/p/1', created_at: '2026-03-04T09:55:00Z', updated_at: '2026-03-04T10:00:00Z', source: 'push' },
      ]),
      getPipelineJobs: vi.fn().mockResolvedValue([
        { id: 10, name: 'lint', stage: 'test', status: 'failed', web_url: 'https://gl/j/10', duration: 30, failure_reason: 'script_failure' },
        { id: 11, name: 'build', stage: 'build', status: 'success', web_url: 'https://gl/j/11', duration: 60 },
      ]),
    }
  })

  it('returns new failed pipelines with only failed job details', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => db, () => 123)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    const result = await tool.execute({}, {} as any)

    expect(result.success).toBe(true)
    const data = JSON.parse(result.output)
    expect(data.new).toHaveLength(1)
    expect(data.new[0].pipeline.id).toBe(1)
    expect(data.new[0].failedJobs).toHaveLength(1)  // only the failed job
    expect(data.new[0].failedJobs[0].name).toBe('lint')
    expect(data.ongoing).toHaveLength(0)
    expect(data.resolved).toHaveLength(0)
  })

  it('returns empty when no failed pipelines', async () => {
    mockClient.listPipelines = vi.fn().mockResolvedValue([])
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => db, () => 123)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    const result = await tool.execute({}, {} as any)

    const data = JSON.parse(result.output)
    expect(data.new).toHaveLength(0)
    expect(data.summary).toContain('0 new')
  })

  it('returns not configured when client is null', async () => {
    const tools = buildGitLabTools(() => null, () => db, () => 123)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    const result = await tool.execute({}, {} as any)

    expect(result.success).toBe(false)
    expect(result.output).toContain('not configured')
  })

  it('returns error when no project_id available', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => db, () => undefined)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    const result = await tool.execute({}, {} as any)

    expect(result.success).toBe(false)
    expect(result.output).toContain('project_id')
  })

  it('uses project_id from args over default', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => db, () => 999)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    await tool.execute({ project_id: 456 }, {} as any)

    expect(mockClient.listPipelines).toHaveBeenCalledWith(456, expect.any(Object))
  })

  it('marks new events as notified in tracker', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => db, () => 123)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    await tool.execute({}, {} as any)

    const row = db.prepare('SELECT status, notify_count FROM gitlab_event_state WHERE event_key = ?').get('pipeline:1') as any
    expect(row.status).toBe('notified')
    expect(row.notify_count).toBe(1)
  })

  it('detects resolved pipelines on second poll', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => db, () => 123)
    const tool = tools.find(t => t.name === 'gitlab_check_pipelines')!

    // First poll - pipeline fails
    await tool.execute({}, {} as any)

    // Second poll - pipeline gone (fixed)
    mockClient.listPipelines = vi.fn().mockResolvedValue([])
    const result = await tool.execute({}, {} as any)

    const data = JSON.parse(result.output)
    expect(data.resolved).toHaveLength(1)
  })
})

describe('gitlab raw API tools — default project fallback', () => {
  let mockClient: Partial<GitLabClient>

  beforeEach(() => {
    mockClient = {
      listPipelines: vi.fn().mockResolvedValue([]),
      listMergeRequests: vi.fn().mockResolvedValue([]),
      listIssues: vi.fn().mockResolvedValue([]),
      getPipelineJobs: vi.fn().mockResolvedValue([]),
      getJobLog: vi.fn().mockResolvedValue('log output'),
      getMergeRequestNotes: vi.fn().mockResolvedValue([]),
      getMergeRequestDiff: vi.fn().mockResolvedValue({ changes: [] }),
    }
  })

  it('gitlab_list_pipelines falls back to default project_id', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => null, () => 42)
    const tool = tools.find(t => t.name === 'gitlab_list_pipelines')!

    await tool.execute({}, {} as any)

    expect(mockClient.listPipelines).toHaveBeenCalledWith(42, expect.any(Object))
  })

  it('gitlab_list_pipelines returns error without project_id', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => null, () => undefined)
    const tool = tools.find(t => t.name === 'gitlab_list_pipelines')!

    const result = await tool.execute({}, {} as any)

    expect(result.success).toBe(false)
    expect(result.error).toContain('project_id')
  })

  it('gitlab_list_mrs uses arg project_id over default', async () => {
    const tools = buildGitLabTools(() => mockClient as GitLabClient, () => null, () => 42)
    const tool = tools.find(t => t.name === 'gitlab_list_mrs')!

    await tool.execute({ project_id: 99 }, {} as any)

    expect(mockClient.listMergeRequests).toHaveBeenCalledWith(99, expect.any(Object))
  })

  it('gitlab_create_mr returns not configured when no client', async () => {
    const tools = buildGitLabTools(() => null, () => null, () => 42)
    const tool = tools.find(t => t.name === 'gitlab_create_mr')!

    const result = await tool.execute({ source_branch: 'feat', title: 'test' }, {} as any)

    expect(result.success).toBe(false)
    expect(result.error).toContain('not configured')
  })
})
