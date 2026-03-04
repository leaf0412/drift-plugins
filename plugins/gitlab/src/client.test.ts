// Unit tests for GitLabClient API methods
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GitLabClient } from './client.js'

// -- Helpers --------------------------------------------------------------

const BASE_URL = 'https://gitlab.example.com'
const TOKEN = 'test-token-abc123'

function createClient() {
  return new GitLabClient({ baseUrl: BASE_URL, token: TOKEN })
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  })
}

function errorResponse(status: number, body = 'Not Found') {
  return new Response(body, { status })
}

// -- Setup ----------------------------------------------------------------

let mockFetch: ReturnType<typeof vi.fn>
let client: GitLabClient

beforeEach(() => {
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
  client = createClient()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// -- Shared assertion helpers ---------------------------------------------

function expectCalledWith(urlSubstring: string, method = 'GET') {
  expect(mockFetch).toHaveBeenCalledOnce()
  const [url, init] = mockFetch.mock.calls[0]
  expect(url).toContain(urlSubstring)
  expect(init.method).toBe(method)
  expect(init.headers['PRIVATE-TOKEN']).toBe(TOKEN)
  return url as string
}

// -- listPipelines --------------------------------------------------------

describe('GitLabClient.listPipelines', () => {
  const pipelines = [
    {
      id: 100,
      iid: 1,
      status: 'success',
      ref: 'main',
      sha: 'abc123',
      web_url: 'https://gitlab.example.com/project/-/pipelines/100',
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-01T01:00:00Z',
      source: 'push',
    },
  ]

  it('calls correct URL with default per_page=20', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(pipelines))

    const result = await client.listPipelines(42)

    const url = expectCalledWith('/api/v4/projects/42/pipelines')
    expect(url).toContain('per_page=20')
    expect(result).toEqual(pipelines)
  })

  it('passes optional filters as query params', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(pipelines))

    await client.listPipelines(42, {
      status: 'failed',
      ref: 'develop',
      updatedAfter: '2026-01-01T00:00:00Z',
      perPage: 50,
    })

    const url = expectCalledWith('/api/v4/projects/42/pipelines')
    expect(url).toContain('status=failed')
    expect(url).toContain('ref=develop')
    expect(url).toContain('updated_after=2026-01-01T00%3A00%3A00Z')
    expect(url).toContain('per_page=50')
  })

  it('omits undefined optional params from URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))

    await client.listPipelines(42, { status: 'running' })

    const url = expectCalledWith('/api/v4/projects/42/pipelines')
    expect(url).toContain('status=running')
    expect(url).not.toContain('ref=')
    expect(url).not.toContain('updated_after=')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'))

    await expect(client.listPipelines(42)).rejects.toThrow('GitLab API error 403')
  })
})

// -- getPipelineJobs ------------------------------------------------------

describe('GitLabClient.getPipelineJobs', () => {
  const jobs = [
    {
      id: 200,
      name: 'build',
      stage: 'build',
      status: 'success',
      web_url: 'https://gitlab.example.com/project/-/jobs/200',
      duration: 45.2,
      failure_reason: undefined,
    },
    {
      id: 201,
      name: 'test',
      stage: 'test',
      status: 'failed',
      web_url: 'https://gitlab.example.com/project/-/jobs/201',
      duration: null,
      failure_reason: 'script_failure',
    },
  ]

  it('calls correct URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(jobs))

    const result = await client.getPipelineJobs(42, 100)

    expectCalledWith('/api/v4/projects/42/pipelines/100/jobs')
    expect(result).toEqual(jobs)
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404))

    await expect(client.getPipelineJobs(42, 999)).rejects.toThrow('GitLab API error 404')
  })
})

// -- getJobLog ------------------------------------------------------------

describe('GitLabClient.getJobLog', () => {
  const fullLog = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10'

  it('calls correct URL and returns full text', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(fullLog))

    const result = await client.getJobLog(42, 200)

    expectCalledWith('/api/v4/projects/42/jobs/200/trace')
    expect(result).toBe(fullLog)
  })

  it('returns only last N lines when tailLines is set', async () => {
    mockFetch.mockResolvedValueOnce(textResponse(fullLog))

    const result = await client.getJobLog(42, 200, 3)

    expect(result).toBe('line8\nline9\nline10')
  })

  it('returns full log when tailLines exceeds total lines', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('line1\nline2'))

    const result = await client.getJobLog(42, 200, 100)

    expect(result).toBe('line1\nline2')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404))

    await expect(client.getJobLog(42, 999)).rejects.toThrow('GitLab API error 404')
  })
})

// -- listMergeRequests ----------------------------------------------------

describe('GitLabClient.listMergeRequests', () => {
  const mrs = [
    {
      id: 10,
      iid: 1,
      title: 'Fix bug',
      description: 'Fixes #42',
      state: 'opened',
      source_branch: 'fix/bug',
      target_branch: 'main',
      web_url: 'https://gitlab.example.com/project/-/merge_requests/1',
    },
  ]

  it('calls correct URL with default per_page=20', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(mrs))

    const result = await client.listMergeRequests(42)

    const url = expectCalledWith('/api/v4/projects/42/merge_requests')
    expect(url).toContain('per_page=20')
    expect(result).toEqual(mrs)
  })

  it('passes optional filters as query params', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(mrs))

    await client.listMergeRequests(42, {
      state: 'merged',
      authorUsername: 'jdoe',
      updatedAfter: '2026-02-01T00:00:00Z',
      perPage: 10,
    })

    const url = expectCalledWith('/api/v4/projects/42/merge_requests')
    expect(url).toContain('state=merged')
    expect(url).toContain('author_username=jdoe')
    expect(url).toContain('updated_after=2026-02-01T00%3A00%3A00Z')
    expect(url).toContain('per_page=10')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error'))

    await expect(client.listMergeRequests(42)).rejects.toThrow('GitLab API error 500')
  })
})

// -- getMergeRequestNotes -------------------------------------------------

describe('GitLabClient.getMergeRequestNotes', () => {
  const notes = [
    {
      id: 300,
      body: 'Looks good!',
      author: { username: 'reviewer', name: 'Reviewer' },
      created_at: '2026-03-02T10:00:00Z',
      updated_at: '2026-03-02T10:00:00Z',
      system: false,
      resolvable: true,
      resolved: false,
    },
  ]

  it('calls correct URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(notes))

    const result = await client.getMergeRequestNotes(42, 1)

    expectCalledWith('/api/v4/projects/42/merge_requests/1/notes')
    expect(result).toEqual(notes)
  })

  it('passes since filter as updated_after param', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(notes))

    await client.getMergeRequestNotes(42, 1, { since: '2026-03-01T00:00:00Z' })

    const url = expectCalledWith('/api/v4/projects/42/merge_requests/1/notes')
    expect(url).toContain('updated_after=2026-03-01T00%3A00%3A00Z')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404))

    await expect(client.getMergeRequestNotes(42, 999)).rejects.toThrow('GitLab API error 404')
  })
})

// -- getMergeRequestDiff --------------------------------------------------

describe('GitLabClient.getMergeRequestDiff', () => {
  const diffPayload = {
    changes: [
      {
        old_path: 'src/index.ts',
        new_path: 'src/index.ts',
        diff: '@@ -1,3 +1,4 @@\n+import { foo } from "./foo"\n',
      },
    ],
  }

  it('calls correct URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(diffPayload))

    const result = await client.getMergeRequestDiff(42, 1)

    expectCalledWith('/api/v4/projects/42/merge_requests/1/changes')
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].old_path).toBe('src/index.ts')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'))

    await expect(client.getMergeRequestDiff(42, 1)).rejects.toThrow('GitLab API error 403')
  })
})

// -- listIssues -----------------------------------------------------------

describe('GitLabClient.listIssues', () => {
  const issues = [
    {
      id: 400,
      iid: 10,
      title: 'Bug report',
      state: 'opened',
      assignees: [{ username: 'dev1' }],
      labels: ['bug', 'high-priority'],
      web_url: 'https://gitlab.example.com/project/-/issues/10',
      updated_at: '2026-03-03T12:00:00Z',
    },
  ]

  it('calls correct URL with default per_page=20', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(issues))

    const result = await client.listIssues(42)

    const url = expectCalledWith('/api/v4/projects/42/issues')
    expect(url).toContain('per_page=20')
    expect(result).toEqual(issues)
  })

  it('passes optional filters as query params', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(issues))

    await client.listIssues(42, {
      state: 'closed',
      assigneeUsername: 'dev1',
      updatedAfter: '2026-01-15T00:00:00Z',
      perPage: 5,
    })

    const url = expectCalledWith('/api/v4/projects/42/issues')
    expect(url).toContain('state=closed')
    expect(url).toContain('assignee_username=dev1')
    expect(url).toContain('updated_after=2026-01-15T00%3A00%3A00Z')
    expect(url).toContain('per_page=5')
  })

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'))

    await expect(client.listIssues(42)).rejects.toThrow('GitLab API error 401')
  })
})

// -- Existing methods (smoke test) ----------------------------------------

describe('GitLabClient existing methods', () => {
  it('createMergeRequest sends POST with correct body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1, iid: 1, title: 'MR' }))

    await client.createMergeRequest(42, {
      source_branch: 'feat',
      title: 'My MR',
    })

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/v4/projects/42/merge_requests')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({
      source_branch: 'feat',
      title: 'My MR',
      target_branch: 'main',
    })
  })

  it('mergeMergeRequest sends PUT', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1, iid: 1, state: 'merged' }))

    await client.mergeMergeRequest(42, 1, { squash: true })

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/v4/projects/42/merge_requests/1/merge')
    expect(init.method).toBe('PUT')
  })
})
