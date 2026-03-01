import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { listSubscriptions } from './service.js'
import { buildFeedTools } from './tools.js'

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the feed plugin that owns feed subscriptions,
 * HTTP routes, and agent tools.
 */
export function createFeedPlugin(): DriftPlugin {
  return {
    name: 'feed',

    async init(ctx: PluginContext) {
      const db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      // Register agent tools
      const tools = buildFeedTools(db)
      for (const tool of tools) {
        ctx.register(`tool.${tool.name}`, async (data: unknown) => tool.execute(data))
      }
      ctx.logger.debug(`Feed: ${tools.length} tools registered`)

      // HTTP route: GET /api/feeds
      app.get('/api/feeds', (c: any) => {
        const subs = listSubscriptions(db)
        return c.json({ subscriptions: subs })
      })

      ctx.logger.info('Feed plugin initialized')
    },
  }
}

export default createFeedPlugin

// ── Re-exports ────────────────────────────────────────────

export {
  subscribe,
  unsubscribe,
  getSubscription,
  listSubscriptions,
  updateFetchState,
} from './service.js'
export type { Subscription, SubscribeInput } from './service.js'
export { buildFeedTools } from './tools.js'
