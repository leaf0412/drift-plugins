// All GitLab DriftTools: raw API tools + smart check tools

import type Database from 'better-sqlite3'
import type { DriftTool, PluginContext, ToolResult } from '@drift/core/kernel'
import type { GitLabClient, Pipeline, PipelineJob } from './client.js'
import { GitLabEventTracker } from './event-tracker.js'

// -- Types ----------------------------------------------------------------

interface PipelineCheckResult {
  new: { pipeline: Pipeline; failedJobs: PipelineJob[] }[]
  ongoing: { pipeline: Pipeline }[]
  resolved: { pipeline: Pipeline }[]
  summary: string
}

// -- Builder --------------------------------------------------------------

export function buildGitLabTools(
  getClient: () => GitLabClient | null,
  getDb: () => Database.Database | null,
  getDefaultProjectId: () => number | undefined,
): DriftTool[] {
  const notConfigured: ToolResult = {
    success: false,
    output: '',
    error: 'GitLab client not configured',
  }

  return [
    // -- gitlab_list_pipelines --------------------------------------------
    {
      name: 'gitlab_list_pipelines',
      description: 'List recent pipelines for a GitLab project. Filter by status and ref.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          status: {
            type: 'string',
            description: 'Filter: running, pending, success, failed, canceled',
          },
          ref: {
            type: 'string',
            description: 'Filter by branch or tag name',
          },
          updated_after: {
            type: 'string',
            description: 'ISO 8601 date — only pipelines updated after this time',
          },
        },
        required: [],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, status, ref, updated_after } = (args ?? {}) as {
          project_id?: number
          status?: string
          ref?: string
          updated_after?: string
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const result = await client.listPipelines(projectId, { status, ref, updatedAfter: updated_after })
          return { success: true, output: JSON.stringify(result, null, 2) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_get_pipeline_jobs -----------------------------------------
    {
      name: 'gitlab_get_pipeline_jobs',
      description: 'List jobs for a specific GitLab pipeline.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          pipeline_id: {
            type: 'number',
            description: 'Pipeline ID to list jobs for',
          },
        },
        required: ['pipeline_id'],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, pipeline_id } = (args ?? {}) as {
          project_id?: number
          pipeline_id: number
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const result = await client.getPipelineJobs(projectId, pipeline_id)
          return { success: true, output: JSON.stringify(result, null, 2) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_get_job_log -----------------------------------------------
    {
      name: 'gitlab_get_job_log',
      description: 'Get the raw log output of a GitLab CI job. Returns the last N lines (default 100).',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          job_id: {
            type: 'number',
            description: 'Job ID to retrieve the log for',
          },
          tail_lines: {
            type: 'number',
            description: 'Number of lines from the end to return (default: 100)',
          },
        },
        required: ['job_id'],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, job_id, tail_lines } = (args ?? {}) as {
          project_id?: number
          job_id: number
          tail_lines?: number
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const log = await client.getJobLog(projectId, job_id, tail_lines ?? 100)
          return { success: true, output: log }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_list_mrs --------------------------------------------------
    {
      name: 'gitlab_list_mrs',
      description: 'List merge requests for a GitLab project. Filter by state and author.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          state: {
            type: 'string',
            description: 'Filter: opened, closed, merged, all',
          },
          author_username: {
            type: 'string',
            description: 'Filter by author username',
          },
          updated_after: {
            type: 'string',
            description: 'ISO 8601 date — only MRs updated after this time',
          },
        },
        required: [],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, state, author_username, updated_after } = (args ?? {}) as {
          project_id?: number
          state?: string
          author_username?: string
          updated_after?: string
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const result = await client.listMergeRequests(projectId, {
            state,
            authorUsername: author_username,
            updatedAfter: updated_after,
          })
          return { success: true, output: JSON.stringify(result, null, 2) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_get_mr_notes ----------------------------------------------
    {
      name: 'gitlab_get_mr_notes',
      description: 'Get comments (notes) on a GitLab merge request. Optionally filter by date.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          mr_iid: {
            type: 'number',
            description: 'Internal ID of the merge request',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 date — only notes updated after this time',
          },
        },
        required: ['mr_iid'],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, mr_iid, since } = (args ?? {}) as {
          project_id?: number
          mr_iid: number
          since?: string
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const result = await client.getMergeRequestNotes(projectId, mr_iid, { since })
          return { success: true, output: JSON.stringify(result, null, 2) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_get_mr_diff -----------------------------------------------
    {
      name: 'gitlab_get_mr_diff',
      description: 'Get the diff (file changes) for a GitLab merge request.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          mr_iid: {
            type: 'number',
            description: 'Internal ID of the merge request',
          },
        },
        required: ['mr_iid'],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, mr_iid } = (args ?? {}) as {
          project_id?: number
          mr_iid: number
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const result = await client.getMergeRequestDiff(projectId, mr_iid)
          return { success: true, output: JSON.stringify(result, null, 2) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_list_issues -----------------------------------------------
    {
      name: 'gitlab_list_issues',
      description: 'List issues for a GitLab project. Filter by state and assignee.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          state: {
            type: 'string',
            description: 'Filter: opened, closed, all',
          },
          assignee_username: {
            type: 'string',
            description: 'Filter by assignee username',
          },
          updated_after: {
            type: 'string',
            description: 'ISO 8601 date — only issues updated after this time',
          },
        },
        required: [],
      },

      async execute(args: unknown): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured
        const { project_id, state, assignee_username, updated_after } = (args ?? {}) as {
          project_id?: number
          state?: string
          assignee_username?: string
          updated_after?: string
        }
        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }
        try {
          const result = await client.listIssues(projectId, {
            state,
            assigneeUsername: assignee_username,
            updatedAfter: updated_after,
          })
          return { success: true, output: JSON.stringify(result, null, 2) }
        } catch (err) {
          return { success: false, output: '', error: (err as Error).message }
        }
      },
    },

    // -- gitlab_create_mr -------------------------------------------------
    {
      name: 'gitlab_create_mr',
      description: 'Create a GitLab merge request from a source branch into a target branch.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          source_branch: {
            type: 'string',
            description: 'The branch containing the changes to merge',
          },
          title: {
            type: 'string',
            description: 'Title of the merge request',
          },
          target_branch: {
            type: 'string',
            description: 'Branch to merge into (default: "main")',
          },
          description: {
            type: 'string',
            description: 'Optional description / body of the merge request',
          },
        },
        required: ['source_branch', 'title'],
      },

      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured

        const { project_id, source_branch, title, target_branch, description } = (args ?? {}) as {
          project_id?: number
          source_branch: string
          title: string
          target_branch?: string
          description?: string
        }

        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }

        try {
          const mr = await client.createMergeRequest(projectId, {
            source_branch,
            target_branch: target_branch ?? 'main',
            title,
            description,
          })
          return {
            success: true,
            output: `Merge request created: ${mr.web_url}`,
            data: mr,
          }
        } catch (err) {
          return {
            success: false,
            output: '',
            error: (err as Error).message,
          }
        }
      },
    },

    // -- gitlab_merge_mr --------------------------------------------------
    {
      name: 'gitlab_merge_mr',
      description: 'Accept (merge) an existing GitLab merge request by project ID and MR IID.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'GitLab project ID (falls back to configured default)',
          },
          mr_iid: {
            type: 'number',
            description: 'Internal ID of the merge request within the project',
          },
          squash: {
            type: 'boolean',
            description: 'If true, squash all commits into one when merging',
          },
        },
        required: ['mr_iid'],
      },

      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const client = getClient()
        if (!client) return notConfigured

        const { project_id, mr_iid, squash } = (args ?? {}) as {
          project_id?: number
          mr_iid: number
          squash?: boolean
        }

        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return { success: false, output: 'No project_id provided and no default configured', error: 'No project_id provided and no default configured' }
        }

        try {
          const mr = await client.mergeMergeRequest(projectId, mr_iid, { squash })
          return {
            success: true,
            output: `Merge request ${mr.iid} merged successfully (state: ${mr.state})`,
            data: mr,
          }
        } catch (err) {
          return {
            success: false,
            output: '',
            error: (err as Error).message,
          }
        }
      },
    },

    // -- gitlab_check_pipelines (smart dedup) -----------------------------
    {
      name: 'gitlab_check_pipelines',
      description:
        'Check for failed GitLab pipelines. Deduplicates across polls — returns new failures (with failed job details), ongoing failures, and resolved pipelines.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'number',
            description: 'Numeric GitLab project ID (falls back to configured default)',
          },
          ref: {
            type: 'string',
            description: 'Filter pipelines by branch name',
          },
        },
        required: [],
      },

      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const client = getClient()
        if (!client) {
          return {
            success: false,
            output: 'GitLab client not configured',
            error: 'GitLab client not configured',
          }
        }

        const db = getDb()
        if (!db) {
          return {
            success: false,
            output: 'Database not available',
            error: 'Database not available',
          }
        }

        const { project_id, ref } = (args ?? {}) as {
          project_id?: number
          ref?: string
        }

        const projectId = project_id ?? getDefaultProjectId()
        if (!projectId) {
          return {
            success: false,
            output: 'No project_id provided and no default configured',
            error: 'No project_id provided and no default configured',
          }
        }

        try {
          const tracker = new GitLabEventTracker(db)

          // 1. Fetch failed pipelines from GitLab
          const pipelines = await client.listPipelines(projectId, {
            status: 'failed',
            ref,
          })

          // 2. Build tracked events
          const events = pipelines.map(p => ({
            key: `pipeline:${p.id}`,
            payload: p as unknown as Record<string, unknown>,
          }))

          // 3. Dedup via tracker
          const changes = tracker.trackEvents('pipeline_failed', projectId, events)

          // 4. Enrich new events with failed job details
          const newItems: PipelineCheckResult['new'] = []
          for (const evt of changes.new) {
            const pipeline = evt.payload as unknown as Pipeline
            const jobs = await client.getPipelineJobs(projectId, pipeline.id)
            const failedJobs = jobs.filter(j => j.status === 'failed')
            tracker.markNotified(evt.key)
            newItems.push({ pipeline, failedJobs })
          }

          // 5. Process ongoing events
          const ongoingItems: PipelineCheckResult['ongoing'] = []
          for (const evt of changes.ongoing) {
            const pipeline = evt.payload as unknown as Pipeline
            tracker.markNotified(evt.key)
            ongoingItems.push({ pipeline })
          }

          // 6. Process resolved events
          const resolvedItems: PipelineCheckResult['resolved'] = []
          for (const evt of changes.resolved) {
            const pipeline = evt.payload as unknown as Pipeline
            resolvedItems.push({ pipeline })
          }

          // 7. Build result
          const result: PipelineCheckResult = {
            new: newItems,
            ongoing: ongoingItems,
            resolved: resolvedItems,
            summary: `${newItems.length} new failures, ${ongoingItems.length} ongoing, ${resolvedItems.length} resolved`,
          }

          return {
            success: true,
            output: JSON.stringify(result),
            data: result,
          }
        } catch (err) {
          return {
            success: false,
            output: '',
            error: (err as Error).message,
          }
        }
      },
    },
  ]
}
