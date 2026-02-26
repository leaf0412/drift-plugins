import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { getStorageDb, getHttpApp } from '@drift/plugins'
import { createEmbeddingService, type EmbeddingConfig } from './embeddings.js'
import { registerMemoryRoutes } from './routes.js'
import { buildMemoryTools } from './tools.js'
import { ensureMemoryDigestAgent } from './digest-agent.js'

// ── Manifest ──────────────────────────────────────────────

const manifest: PluginManifest = {
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
    manifest,

    async init(ctx: PluginContext) {
      const db = getStorageDb(ctx)
      const app = getHttpApp(ctx)

      const embedSvc = embeddingConfig
        ? createEmbeddingService(embeddingConfig)
        : null

      registerMemoryRoutes(app, { db, embedSvc })

      // Register agent tools via PluginRegistry
      if (ctx.registerTool) {
        const tools = buildMemoryTools(db)
        for (const tool of tools) {
          ctx.registerTool(tool)
        }
        ctx.logger.debug(`Memory: ${tools.length} tools registered via ctx.registerTool`)
      }

      // Install memory-digest agent definition if mind.dir is available
      try {
        const mindDir = ctx.atoms.atom<string>('mind.dir', '').deref()
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

// ── Re-exports ────────────────────────────────────────────

export { createEmbeddingService } from './embeddings.js'
export type { EmbeddingConfig, EmbeddingService, MemoryEntry } from './embeddings.js'
export { registerMemoryRoutes } from './routes.js'
export type { MemoryRouteDeps } from './routes.js'
export { buildMemoryTools } from './tools.js'
export { ensureMemoryDigestAgent } from './digest-agent.js'
