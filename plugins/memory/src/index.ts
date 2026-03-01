import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import { createEmbeddingService, type EmbeddingConfig } from './embeddings.js'
import { registerMemoryRoutes } from './routes.js'
import { buildMemoryTools } from './tools.js'
import { ensureMemoryDigestAgent } from './digest-agent.js'

// ── Manifest ──────────────────────────────────────────────

const manifest = {
  name: 'memory',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    routes: ['/api/memory', '/api/knowledge', '/api/recall'],
    storage: ['memories', 'memory_vec', 'knowledge_entries'],
  },
  depends: ['storage', 'http'],
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the memory plugin that owns vector embeddings, memory CRUD,
 * knowledge entries, and semantic recall.
 *
 * If an EmbeddingConfig is provided, the OpenAI embedding service is
 * initialised for auto-embed on memory creation and /api/recall.
 */
export function createMemoryPlugin(embeddingConfig?: EmbeddingConfig): DriftPlugin {
  return {
    name: 'memory',
    manifest,

    async init(ctx: PluginContext) {
      let db: any
      try {
        db = await ctx.call<any>('sqlite.db')
      } catch {
        const atom = (ctx as any).atoms?.atom?.('storage.db', null)
        db = atom?.deref?.()
        if (!db) throw new Error('Storage plugin not initialized')
      }

      let app: any
      try {
        app = await ctx.call<any>('http.app', { pluginId: ctx.pluginId })
      } catch {
        const atom = (ctx as any).atoms?.atom?.('http.app', null)
        app = atom?.deref?.()
        if (!app) throw new Error('HTTP plugin not initialized')
      }

      const embedSvc = embeddingConfig
        ? createEmbeddingService(embeddingConfig)
        : null

      registerMemoryRoutes(app, { db, embedSvc })

      // Register agent tools
      const tools = buildMemoryTools(db)
      for (const tool of tools) {
        if (typeof ctx.register === 'function') {
          ctx.register(`tool.${tool.name}`, async (data: unknown) => tool.execute(data))
        } else if ((ctx as any).registerTool) {
          (ctx as any).registerTool(tool)
        }
      }
      ctx.logger.debug(`Memory: ${tools.length} tools registered`)

      // Install memory-digest agent definition if mind.dir is available
      try {
        let mindDir: string | undefined
        try {
          mindDir = await ctx.call<string>('mind.dir')
        } catch {
          const atom = (ctx as any).atoms?.atom?.('mind.dir', '')
          mindDir = atom?.deref?.()
        }
        if (mindDir) {
          ensureMemoryDigestAgent(mindDir)
          ctx.logger.debug('Memory: ensured memory-digest agent definition')
        }
      } catch {
        // mind plugin may not be loaded yet — safe to skip
      }

      ctx.logger.info(
        `Memory plugin initialized (embeddings: ${embedSvc ? 'enabled' : 'disabled'})`
      )
    },
  }
}

export default createMemoryPlugin

// ── Re-exports ────────────────────────────────────────────

export { createEmbeddingService } from './embeddings.js'
export type { EmbeddingConfig, EmbeddingService, MemoryEntry } from './embeddings.js'
export { registerMemoryRoutes } from './routes.js'
export type { MemoryRouteDeps } from './routes.js'
export { buildMemoryTools } from './tools.js'
export { ensureMemoryDigestAgent } from './digest-agent.js'
