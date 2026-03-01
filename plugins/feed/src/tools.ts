import type { DriftTool, ToolResult, PluginContext } from '@drift/core/kernel'
import type Database from 'better-sqlite3'
import {
  subscribe,
  listSubscriptions,
  unsubscribe,
} from './service.js'

/**
 * Build 3 feed tool definitions as declarative DriftTool[].
 *
 * - feed_subscribe   — subscribe to a feed source
 * - feed_list        — list all subscriptions
 * - feed_unsubscribe — remove a subscription by ID
 */
export function buildFeedTools(getDb: () => Database.Database): DriftTool[] {
  return [
    // ── feed_subscribe ─────────────────────────────────────────
    {
      name: 'feed_subscribe',
      description:
        'Subscribe to a feed source (RSS, webpage, or API). Returns the created subscription as JSON.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to subscribe to (required)',
          },
          type: {
            type: 'string',
            enum: ['rss', 'webpage', 'api'],
            description: 'Source type (required)',
          },
          title: {
            type: 'string',
            description: 'Human-readable title for the subscription',
          },
          cron: {
            type: 'string',
            description: 'Cron expression for fetch schedule (default: "0 8 * * *")',
          },
        },
        required: ['url', 'type'],
      },
      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const db = getDb()
        try {
          const { url, type, title, cron } = args as {
            url?: string
            type?: string
            title?: string
            cron?: string
          }

          if (!url) {
            return { success: false, output: '', error: 'url is required' }
          }
          if (!type || !['rss', 'webpage', 'api'].includes(type)) {
            return { success: false, output: '', error: 'type is required and must be rss, webpage, or api' }
          }

          const sub = subscribe(db, {
            url,
            type: type as 'rss' | 'webpage' | 'api',
            title,
            cron,
          })

          return { success: true, output: JSON.stringify(sub) }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },

    // ── feed_list ──────────────────────────────────────────────
    {
      name: 'feed_list',
      description:
        'List all feed subscriptions. Returns a JSON array ordered by most recently created.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute(_args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const db = getDb()
        try {
          const subs = listSubscriptions(db)
          return { success: true, output: JSON.stringify(subs) }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },

    // ── feed_unsubscribe ───────────────────────────────────────
    {
      name: 'feed_unsubscribe',
      description:
        'Unsubscribe from a feed by subscription ID. Returns "Unsubscribed" on success.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Subscription ID to remove (required)',
          },
        },
        required: ['id'],
      },
      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const db = getDb()
        try {
          const { id } = args as { id?: string }

          if (!id) {
            return { success: false, output: '', error: 'id is required' }
          }

          const deleted = unsubscribe(db, id)
          if (!deleted) {
            return { success: false, output: '', error: `Subscription not found: ${id}` }
          }

          return { success: true, output: 'Unsubscribed' }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },
  ]
}
