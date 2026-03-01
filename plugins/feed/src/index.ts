import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import { listSubscriptions } from './service.js'
import { buildFeedTools } from './tools.js'

// ── Manifest ──────────────────────────────────────────────

const manifest = {
  name: 'feed',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    routes: ['/api/feeds'],
    events: { emit: ['feed.update', 'feed.error'] },
  },
  depends: ['storage', 'http'],
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the feed plugin that owns feed subscriptions,
 * HTTP routes, and agent tools.
 */
export function createFeedPlugin(): DriftPlugin {
  return {
    name: 'feed',
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

      // Register agent tools
      const tools = buildFeedTools(db)
      for (const tool of tools) {
        if (typeof ctx.register === 'function') {
          ctx.register(`tool.${tool.name}`, async (data: unknown) => tool.execute(data))
        } else if ((ctx as any).registerTool) {
          (ctx as any).registerTool(tool)
        }
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
