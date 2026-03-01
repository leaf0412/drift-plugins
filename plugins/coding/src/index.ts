import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { registerCodingRoutes } from './routes.js'
import { buildCodingTools } from './tools.js'

// ── Plugin Factory ────────────────────────────────────────────

export function createCodingPlugin(): DriftPlugin {
  const workspaceMap = new Map<string, string>()
  let warnLog: ((msg: string) => void) | null = null

  return {
    name: 'coding',
    requiresCapabilities: ['sqlite.db', 'http.app'],

    tools: buildCodingTools(() => {
      if (workspaceMap.size === 0) return null
      if (workspaceMap.size > 1) {
        warnLog?.(`Coding: ${workspaceMap.size} concurrent sessions, using first workspace`)
      }
      return [...workspaceMap.values()][0]
    }),

    async init(ctx: PluginContext) {
      warnLog = (msg) => ctx.logger.warn(msg)
      const db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      // Register HTTP routes — pass workspace setter so the chat route
      // can activate the correct workspace before streaming begins.
      registerCodingRoutes(app, {
        db,
        getChatStream: () => {
          // chat.stream is resolved at call time (lazy), so we return a thunk
          // that awaits the capability — callers that need it synchronously
          // (old pattern) get null; async callers use the returned promise.
          return null
        },
        getChatStreamAsync: () => ctx.call<any>('chat.stream').catch(() => null),
        setActiveWorkspace: (sessionId: string, path: string | null) => {
          if (path) workspaceMap.set(sessionId, path)
          else workspaceMap.delete(sessionId)
        },
      })

      ctx.logger.info('Coding plugin initialized')
    },
  }
}

export default createCodingPlugin

// ── Re-exports ────────────────────────────────────────────────

export { registerCodingRoutes } from './routes.js'
export type { CodingRouteDeps } from './routes.js'
export { buildCodingTools } from './tools.js'
export { buildCodingPrompt } from './prompt.js'
export {
  createCodingSession,
  getCodingSession,
  listCodingSessions,
  updateCodingSession,
  deleteCodingSession,
} from './session.js'
export type { CodingSession, CreateSessionOpts } from './session.js'
export {
  createWorkspaceDir,
  removeWorkspaceDir,
  isPathInWorkspace,
  initGitRepo,
  WORKSPACES_DIR,
} from './sandbox.js'
