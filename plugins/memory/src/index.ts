import type { DriftPlugin, PluginContext, Unsubscribe } from '@drift/core/kernel'
import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'
import { createEmbeddingService, type EmbeddingConfig } from './embeddings.js'
import { registerMemoryRoutes } from './routes.js'
import { buildMemoryTools } from './tools.js'
import { ensureMemoryDigestAgent } from './digest-agent.js'
import { shouldExtract, parseExtractionResult, EXTRACTION_PROMPT } from './extractor.js'

// ── Helpers ───────────────────────────────────────────────

/** Upsert a structured fact into the memory table (shared by tools and extractor). */
function memorySave(
  db: Database.Database,
  entry: { type: string; key: string; value: string; project?: string },
): void {
  const id = nanoid()
  const now = dayjs().toISOString()
  const project = entry.project ?? ''

  db.prepare(
    `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project, type, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(id, project, entry.type, entry.key, entry.value, now, now)
}

// ── Plugin Factory ────────────────────────────────────────

export function createMemoryPlugin(embeddingConfig?: EmbeddingConfig): DriftPlugin {
  let db: Database.Database | null = null
  let unsubChatComplete: Unsubscribe | null = null

  return {
    name: 'memory',
    version: '1.2.0',

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

      // ── PostChatExtractor: auto-extract memories from completed sessions ──
      unsubChatComplete = ctx.on('chat.complete', async (data: unknown) => {
        try {
          const { sessionId } = data as { sessionId: string }
          if (!sessionId || !db) return

          // Check if already extracted
          const session = db.prepare('SELECT extracted FROM sessions WHERE id = ?').get(sessionId) as { extracted?: number } | undefined
          if (session?.extracted) return

          // Count messages
          const { count } = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number }
          if (!shouldExtract(count)) return

          // Get messages for context
          const messages = db.prepare(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 20',
          ).all(sessionId) as Array<{ role: string; content: string }>

          const conversation = messages
            .filter((m) => m.content)
            .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
            .join('\n')

          // Call cheapest LLM via capability
          const llmResponse = await ctx.call<string>('llm.chat', {
            messages: [
              { role: 'system', content: EXTRACTION_PROMPT },
              { role: 'user', content: conversation },
            ],
            preferCheap: true,
          })

          const extracted = parseExtractionResult(typeof llmResponse === 'string' ? llmResponse : '')

          // Save facts via memorySave helper (reuse upsert logic)
          for (const fact of extracted.facts) {
            try {
              memorySave(db, { type: fact.type, key: fact.key, value: fact.value })
            } catch { /* duplicate — ignore */ }
          }

          // Create implicit reminders via capability
          for (const reminder of extracted.reminders) {
            try {
              await ctx.call('reminder.create', {
                content: reminder.content,
                remindAt: reminder.remind_at,
                source: 'implicit',
              })
            } catch { /* reminder plugin not loaded — ignore */ }
          }

          // Update session tags
          if (extracted.topics.length > 0) {
            db.prepare('UPDATE sessions SET tags = ?, extracted = 1 WHERE id = ?')
              .run(JSON.stringify(extracted.topics), sessionId)
          } else {
            db.prepare('UPDATE sessions SET extracted = 1 WHERE id = ?').run(sessionId)
          }

          ctx.logger.info(
            `Extracted from session ${sessionId}: ${extracted.facts.length} facts, ${extracted.reminders.length} reminders, ${extracted.topics.length} topics`,
          )
        } catch (err) {
          ctx.logger.warn(`PostChatExtractor error: ${err}`)
        }
      })

      ctx.logger.info(
        `Memory plugin initialized (embeddings: ${embedSvc ? 'enabled' : 'disabled'})`,
      )
    },

    async stop() {
      if (unsubChatComplete) {
        unsubChatComplete()
        unsubChatComplete = null
      }
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
export { shouldExtract, parseExtractionResult, EXTRACTION_PROMPT } from './extractor.js'
export type { ExtractionResult } from './extractor.js'
