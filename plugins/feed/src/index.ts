import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { getStorageDb, getHttpApp } from '@drift/plugins'
import { listSubscriptions } from './service.js'
import { buildFeedTools } from './tools.js'

// ── Manifest ──────────────────────────────────────────────

const manifest: PluginManifest = {
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
    manifest,

    async init(ctx: PluginContext) {
      const db = getStorageDb(ctx)
      const app = getHttpApp(ctx)

      // Register agent tools via PluginRegistry
      if (ctx.registerTool) {
        const tools = buildFeedTools(db)
        for (const tool of tools) {
          ctx.registerTool(tool)
        }
        ctx.logger.debug(`Feed: ${tools.length} tools registered via ctx.registerTool`)
      }

      // HTTP route: GET /api/feeds
      app.get('/api/feeds', (c) => {
        const subs = listSubscriptions(db)
        return c.json({ subscriptions: subs })
      })

      ctx.logger.info('Feed plugin initialized')
    },
  }
}

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
