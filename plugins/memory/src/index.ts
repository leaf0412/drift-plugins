import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { createEmbeddingService, type EmbeddingConfig } from './embeddings.js'
import { registerMemoryRoutes } from './routes.js'
import { buildMemoryTools } from './tools.js'
import { ensureMemoryDigestAgent } from './digest-agent.js'

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

    async init(ctx: PluginContext) {
      const db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      const embedSvc = embeddingConfig
        ? createEmbeddingService(embeddingConfig)
        : null

      registerMemoryRoutes(app, { db, embedSvc })

      // Register agent tools
      const tools = buildMemoryTools(db)
      for (const tool of tools) {
        ctx.register(`tool.${tool.name}`, async (data: unknown) => tool.execute(data))
      }
      ctx.logger.debug(`Memory: ${tools.length} tools registered`)

      // Install memory-digest agent definition if mind.dir is available
      try {
        const mindDir = await ctx.call<string>('mind.dir')
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
