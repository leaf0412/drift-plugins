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
  let db: Database.Database | null = null

  return {
    name: 'feed',
    tools: buildFeedTools(() => db!),

    async init(ctx: PluginContext) {
      db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      // HTTP route: GET /api/feeds
      app.get('/api/feeds', (c: any) => {
        const subs = listSubscriptions(db!)
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
