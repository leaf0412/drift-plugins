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
 * If an EmbeddingConfig is provided (constructor override), the OpenAI
 * embedding service is initialised directly. Otherwise, config is read
 * from ctx.config in init().
 */
export function createMemoryPlugin(embeddingConfig?: EmbeddingConfig): DriftPlugin {
  let db: Database.Database | null = null

  return {
    name: 'memory',

    configSchema: {
      apiKey:  { type: 'string', description: 'OpenAI 兼容 API Key (embedding)', secret: true },
      baseURL: { type: 'string', description: 'Embedding API 基础 URL', default: 'https://api.openai.com/v1' },
      model:   { type: 'string', description: 'Embedding 模型名', default: 'text-embedding-3-small' },
    },
    requiresCapabilities: ['sqlite.db', 'http.app'],

    tools: buildMemoryTools(() => db!),

    async init(ctx: PluginContext) {
      db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      // Resolve embedding config: constructor override → ctx.config
      let embedSvc = null
      if (embeddingConfig) {
        embedSvc = createEmbeddingService(embeddingConfig)
      } else {
        const apiKey = ctx.config.get<string>('apiKey')
        const baseURL = ctx.config.get<string>('baseURL', 'https://api.openai.com/v1')
        const model = ctx.config.get<string>('model', 'text-embedding-3-small')
        if (apiKey) {
          embedSvc = createEmbeddingService({ apiKey, baseURL, model })
        } else {
          ctx.logger.warn('Memory plugin: no apiKey configured, embeddings disabled')
        }
      }

      registerMemoryRoutes(app, { db, embedSvc })

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
