import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type Database from 'better-sqlite3'
import { GitLabClient } from './client.js'
import { buildGitLabTools } from './tools.js'

// -- Plugin Factory -------------------------------------------------------

export function createGitLabPlugin(): DriftPlugin {
  let client: GitLabClient | null = null
  let db: Database.Database | null = null
  let defaultProjectId: number | undefined

  return {
    name: 'gitlab',
    version: '1.0.0',
    requiresCapabilities: ['sqlite.db'],

    capabilities: {
      'gitlab.client': () => client,
    },

    tools: buildGitLabTools(
      () => client,
      () => db,
      () => defaultProjectId,
    ),

    configSchema: {
      'baseUrl': { type: 'string', description: 'GitLab instance URL (e.g. https://gitlab.com)' },
      'token': { type: 'string', description: 'GitLab personal access token', secret: true },
      'defaultProjectId': { type: 'number', description: 'Default project ID for tools' },
    },

    async init(ctx: PluginContext) {
      // Get database
      db = await ctx.call<Database.Database>('sqlite.db')

      // Create event state table
      db.exec(`
        CREATE TABLE IF NOT EXISTS gitlab_event_state (
          event_key    TEXT PRIMARY KEY,
          event_type   TEXT NOT NULL,
          project_id   INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'new',
          first_seen   TEXT NOT NULL,
          last_seen    TEXT NOT NULL,
          notified_at  TEXT,
          notify_count INTEGER DEFAULT 0,
          payload      TEXT,
          resolved_at  TEXT
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_gitlab_event_state_type ON gitlab_event_state(event_type)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_gitlab_event_state_status ON gitlab_event_state(status)')

      // Read config
      const baseUrl = ctx.config.get<string>('baseUrl')
      const token = ctx.config.get<string>('token')
      defaultProjectId = ctx.config.get<number>('defaultProjectId')

      if (baseUrl && token) {
        client = new GitLabClient({ baseUrl, token })
        ctx.logger.info('GitLab client configured')
      } else {
        ctx.logger.warn('GitLab not configured — set baseUrl and token in plugin config')
      }
    },

    async stop() {
      client = null
      db = null
      defaultProjectId = undefined
    },
  }
}

export default createGitLabPlugin

// -- Re-exports -----------------------------------------------------------

export { GitLabClient } from './client.js'
export type {
  GitLabClientOptions,
  MergeRequest,
  CreateMergeRequestParams,
  MergeMergeRequestParams,
  Pipeline,
  PipelineJob,
  MergeRequestNote,
  Issue,
} from './client.js'
export { GitLabEventTracker } from './event-tracker.js'
export type { TrackedEvent, EventChanges, TrackOptions } from './event-tracker.js'
export { buildGitLabTools } from './tools.js'
