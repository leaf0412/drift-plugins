// GitLab REST API client (thin wrapper)

export interface GitLabClientOptions {
  baseUrl: string   // e.g. "https://gitlab.example.com"
  token: string     // Personal Access Token or CI job token
}

export interface MergeRequest {
  id: number
  iid: number
  title: string
  description: string
  state: string
  source_branch: string
  target_branch: string
  web_url: string
}

export interface CreateMergeRequestParams {
  source_branch: string
  target_branch?: string
  title: string
  description?: string
  squash?: boolean
  remove_source_branch?: boolean
}

export interface MergeMergeRequestParams {
  squash?: boolean
  should_remove_source_branch?: boolean
  merge_commit_message?: string
}

export interface Pipeline {
  id: number
  iid: number
  status: string
  ref: string
  sha: string
  web_url: string
  created_at: string
  updated_at: string
  source: string
}

export interface PipelineJob {
  id: number
  name: string
  stage: string
  status: string
  web_url: string
  duration: number | null
  failure_reason?: string
}

export interface MergeRequestNote {
  id: number
  body: string
  author: { username: string; name: string }
  created_at: string
  updated_at: string
  system: boolean
  resolvable: boolean
  resolved: boolean
}

export interface Issue {
  id: number
  iid: number
  title: string
  state: string
  assignees: { username: string }[]
  labels: string[]
  web_url: string
  updated_at: string
}

export class GitLabClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(opts: GitLabClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
  }

  // -- Internal -------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`
    const res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`GitLab API error ${res.status}: ${text}`)
    }

    return res.json() as Promise<T>
  }

  private async requestText(
    method: string,
    path: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/api/v4${path}`
    const res = await fetch(url, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`GitLab API error ${res.status}: ${text}`)
    }

    return res.text()
  }

  // -- Public API -----------------------------------------------------

  /**
   * Create a merge request for the given project.
   */
  async createMergeRequest(
    projectId: number,
    params: CreateMergeRequestParams,
  ): Promise<MergeRequest> {
    return this.request<MergeRequest>(
      'POST',
      `/projects/${projectId}/merge_requests`,
      {
        source_branch: params.source_branch,
        target_branch: params.target_branch ?? 'main',
        title: params.title,
        description: params.description,
        squash: params.squash,
        remove_source_branch: params.remove_source_branch,
      },
    )
  }

  /**
   * Accept (merge) an existing merge request.
   */
  async mergeMergeRequest(
    projectId: number,
    mrIid: number,
    params?: MergeMergeRequestParams,
  ): Promise<MergeRequest> {
    return this.request<MergeRequest>(
      'PUT',
      `/projects/${projectId}/merge_requests/${mrIid}/merge`,
      params,
    )
  }

  /**
   * List pipelines for a project.
   */
  async listPipelines(
    projectId: number,
    opts?: { status?: string; ref?: string; updatedAfter?: string; perPage?: number },
  ): Promise<Pipeline[]> {
    const params = new URLSearchParams()
    params.set('per_page', String(opts?.perPage ?? 20))
    if (opts?.status) params.set('status', opts.status)
    if (opts?.ref) params.set('ref', opts.ref)
    if (opts?.updatedAfter) params.set('updated_after', opts.updatedAfter)
    return this.request<Pipeline[]>('GET', `/projects/${projectId}/pipelines?${params}`)
  }

  /**
   * List jobs for a specific pipeline.
   */
  async getPipelineJobs(projectId: number, pipelineId: number): Promise<PipelineJob[]> {
    return this.request<PipelineJob[]>(
      'GET',
      `/projects/${projectId}/pipelines/${pipelineId}/jobs`,
    )
  }

  /**
   * Get the raw log (trace) for a job. Returns plain text.
   * If tailLines is set, returns only the last N lines.
   */
  async getJobLog(projectId: number, jobId: number, tailLines?: number): Promise<string> {
    const text = await this.requestText('GET', `/projects/${projectId}/jobs/${jobId}/trace`)
    if (tailLines == null) return text
    const lines = text.split('\n')
    return lines.slice(-tailLines).join('\n')
  }

  /**
   * List merge requests for a project.
   */
  async listMergeRequests(
    projectId: number,
    opts?: { state?: string; authorUsername?: string; updatedAfter?: string; perPage?: number },
  ): Promise<MergeRequest[]> {
    const params = new URLSearchParams()
    params.set('per_page', String(opts?.perPage ?? 20))
    if (opts?.state) params.set('state', opts.state)
    if (opts?.authorUsername) params.set('author_username', opts.authorUsername)
    if (opts?.updatedAfter) params.set('updated_after', opts.updatedAfter)
    return this.request<MergeRequest[]>('GET', `/projects/${projectId}/merge_requests?${params}`)
  }

  /**
   * Get notes (comments) on a merge request.
   */
  async getMergeRequestNotes(
    projectId: number,
    mrIid: number,
    opts?: { since?: string },
  ): Promise<MergeRequestNote[]> {
    const params = new URLSearchParams()
    if (opts?.since) params.set('updated_after', opts.since)
    const qs = params.toString()
    return this.request<MergeRequestNote[]>(
      'GET',
      `/projects/${projectId}/merge_requests/${mrIid}/notes${qs ? `?${qs}` : ''}`,
    )
  }

  /**
   * Get the diff (changes) for a merge request.
   */
  async getMergeRequestDiff(
    projectId: number,
    mrIid: number,
  ): Promise<{ changes: { old_path: string; new_path: string; diff: string }[] }> {
    return this.request<{ changes: { old_path: string; new_path: string; diff: string }[] }>(
      'GET',
      `/projects/${projectId}/merge_requests/${mrIid}/changes`,
    )
  }

  /**
   * List issues for a project.
   */
  async listIssues(
    projectId: number,
    opts?: { state?: string; assigneeUsername?: string; updatedAfter?: string; perPage?: number },
  ): Promise<Issue[]> {
    const params = new URLSearchParams()
    params.set('per_page', String(opts?.perPage ?? 20))
    if (opts?.state) params.set('state', opts.state)
    if (opts?.assigneeUsername) params.set('assignee_username', opts.assigneeUsername)
    if (opts?.updatedAfter) params.set('updated_after', opts.updatedAfter)
    return this.request<Issue[]>('GET', `/projects/${projectId}/issues?${params}`)
  }
}
