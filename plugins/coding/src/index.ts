import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { getStorageDb, getHttpApp } from '@drift/plugins'
import { registerCodingRoutes } from './routes.js'
import { buildCodingTools } from './tools.js'

// ── Manifest ──────────────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'coding',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    routes: ['/api/code/sessions', '/api/code/chat', '/api/code/diff', '/api/code/download'],
    storage: ['coding_sessions'],
  },
  depends: ['storage', 'http', 'chat'],
}

// ── Plugin Factory ────────────────────────────────────────────

export function createCodingPlugin(): DriftPlugin {
  return {
    manifest,

    async init(ctx: PluginContext) {
      const db = getStorageDb(ctx)
      const app = getHttpApp(ctx)

      // Register HTTP routes
      registerCodingRoutes(app, {
        db,
        getChatStream: () => {
          try {
            return ctx.atoms.atom<any>('chat.stream', null).deref()
          } catch {
            return null
          }
        },
      })

      // Register git tools via PluginRegistry
      if (ctx.registerTool) {
        // Workspace path is set per-chat via routes — tools use a closure
        // that the route handler sets before each chat invocation.
        // For standalone tool calls, we return null (no active workspace).
        const tools = buildCodingTools(() => null)
        for (const tool of tools) {
          ctx.registerTool(tool)
        }
        ctx.logger.debug(`Coding: ${tools.length} tools registered`)
      }

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
