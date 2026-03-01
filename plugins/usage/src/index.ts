/**
 * Minimal context interface for bridging between old daemon context and new plugin patterns.
 */
interface BridgeCtx {
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void }
  call: <T = unknown>(capability: string, data?: unknown) => Promise<T>
  pluginId?: string
}

export function createUsagePlugin() {
  return {
    name: 'usage',
    version: '0.1.0',

    async init(ctx: BridgeCtx) {
      // Get HTTP app via capability
      let app: any
      try {
        app = await ctx.call('http.app', { pluginId: (ctx as any).pluginId ?? 'usage' })
      } catch {
        ctx.logger.warn('usage: HTTP app not available, skipping route')
        return
      }

      app.get('/api/usage', async (c: any) => {
        const days = parseInt(c.req.query('days') ?? '30', 10) || 30

        let db: any
        try {
          db = await ctx.call('sqlite.db')
        } catch {
          return c.json({
            today: { promptTokens: 0, completionTokens: 0, sessions: 0 },
            monthly: { promptTokens: 0, completionTokens: 0, sessions: 0 },
            daily: [],
            byModel: [],
            topSessions: [],
          })
        }

        // Today's usage
        const todayStr = new Date().toISOString().slice(0, 10)
        const todayRow = db.prepare(`
          SELECT
            COALESCE(SUM(json_extract(usage_json, '$.promptTokens')), 0) as promptTokens,
            COALESCE(SUM(json_extract(usage_json, '$.completionTokens')), 0) as completionTokens,
            COUNT(DISTINCT session_id) as sessions
          FROM messages
          WHERE role = 'assistant' AND usage_json IS NOT NULL
            AND date(created_at) = ?
        `).get(todayStr) as any

        // Monthly usage (last N days)
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - days)
        const cutoffStr = cutoff.toISOString()
        const monthlyRow = db.prepare(`
          SELECT
            COALESCE(SUM(json_extract(usage_json, '$.promptTokens')), 0) as promptTokens,
            COALESCE(SUM(json_extract(usage_json, '$.completionTokens')), 0) as completionTokens,
            COUNT(DISTINCT session_id) as sessions
          FROM messages
          WHERE role = 'assistant' AND usage_json IS NOT NULL
            AND created_at >= ?
        `).get(cutoffStr) as any

        // Daily breakdown
        const daily = db.prepare(`
          SELECT
            date(created_at) as date,
            COALESCE(SUM(json_extract(usage_json, '$.promptTokens')), 0) as promptTokens,
            COALESCE(SUM(json_extract(usage_json, '$.completionTokens')), 0) as completionTokens
          FROM messages
          WHERE role = 'assistant' AND usage_json IS NOT NULL
            AND created_at >= ?
          GROUP BY date(created_at)
          ORDER BY date ASC
        `).all(cutoffStr) as any[]

        // By model
        const byModel = db.prepare(`
          SELECT
            COALESCE(model, 'unknown') as model,
            COALESCE(SUM(json_extract(usage_json, '$.promptTokens')), 0) +
            COALESCE(SUM(json_extract(usage_json, '$.completionTokens')), 0) as tokens
          FROM messages
          WHERE role = 'assistant' AND usage_json IS NOT NULL
            AND created_at >= ?
          GROUP BY model
          ORDER BY tokens DESC
        `).all(cutoffStr) as any[]

        // Top sessions by token usage
        const topSessions = db.prepare(`
          SELECT
            s.id,
            s.title,
            COALESCE(SUM(json_extract(m.usage_json, '$.promptTokens')), 0) +
            COALESCE(SUM(json_extract(m.usage_json, '$.completionTokens')), 0) as tokens
          FROM messages m
          JOIN sessions s ON m.session_id = s.id
          WHERE m.role = 'assistant' AND m.usage_json IS NOT NULL
            AND m.created_at >= ?
          GROUP BY s.id
          ORDER BY tokens DESC
          LIMIT 10
        `).all(cutoffStr) as any[]

        return c.json({
          today: todayRow,
          monthly: monthlyRow,
          daily,
          byModel,
          topSessions,
        })
      })

      ctx.logger.info('usage: /api/usage route registered')
    },
  }
}

export default createUsagePlugin
