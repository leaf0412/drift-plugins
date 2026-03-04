import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Channel } from '@drift/core'
import type Database from 'better-sqlite3'
import type { Hono } from 'hono'
import { logNotification, listNotifications } from './notification-log.js'
import { registerNotifyRoutes } from './routes.js'
import { logEvent } from './event-log.js'
import type { EventLogInput, EventLogEntry } from './event-log.js'

// ── Types ─────────────────────────────────────────────────

type LogEventFn = (input: EventLogInput) => EventLogEntry

// ── Event Formatting ─────────────────────────────────────

/**
 * Extract human-readable content from event payloads.
 * Known event shapes get their content field extracted;
 * unknown payloads fall back to JSON.
 */
function formatEventContent(event: string, data: unknown): string {
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return String(data)

  const obj = data as Record<string, unknown>

  // reminder.fire — extract content + remind_at timestamp
  if (obj.remind_at && typeof obj.content === 'string') {
    return `⏰ 提醒: ${obj.content}\n时间: ${obj.remind_at}`
  }

  // cron.chat / cron.result / chat.complete — extract content + optional jobName header
  if (typeof obj.content === 'string') {
    const jobName = obj.jobName as string | undefined
    return jobName ? `**${jobName}**\n\n${obj.content}` : obj.content
  }

  // task.reminder / cron.notify — extract title + body
  if (typeof obj.title === 'string' && typeof obj.body === 'string') {
    return `**${obj.title}**\n\n${obj.body}`
  }

  // Fallback: JSON
  return JSON.stringify(data)
}

// ── Known event list ──────────────────────────────────────

const SUBSCRIBED_EVENTS = ['cron.result', 'cron.notify', 'cron.chat', 'task.reminder', 'reminder.fire'] as const

// ── DND Helper ────────────────────────────────────────────

function getDndUntil(db: Database.Database | null): string | null {
  if (!db) return null
  try {
    const row = db.prepare("SELECT value FROM notify_settings WHERE key = 'dnd_until'").get() as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the notification dispatcher plugin.
 *
 * On each subscribed event, broadcasts the payload to every registered Channel
 * and logs success/failure to the notification_log table.
 *
 * Supports urgency levels: 'urgent' | 'important' | 'info'.
 * - urgent: always delivered, breaks through DND
 * - important (default): delivered unless DND is active
 * - info: only delivered to web-notify channel
 *
 * Publishes the `event.log` and `notify.dnd` capabilities.
 */
export function createNotifyPlugin(): DriftPlugin {
  const unsubs: Array<() => void> = []
  let db: Database.Database | null = null

  return {
    name: 'notify',
    version: '1.2.0',
    requiresCapabilities: ['sqlite.db', 'http.app'],
    capabilities: {
      'event.log': (data) => logEvent(db!, data as EventLogInput),
      'notify.dnd': (data) => {
        const { until } = data as { until: string | null }
        if (!db) return
        if (until) {
          db.prepare("INSERT OR REPLACE INTO notify_settings (key, value) VALUES ('dnd_until', ?)").run(until)
        } else {
          db.prepare("DELETE FROM notify_settings WHERE key = 'dnd_until'").run()
        }
      },
    },

    async init(ctx: PluginContext) {
      db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      // Create notify_settings table for DND and other settings
      db.exec(`CREATE TABLE IF NOT EXISTS notify_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)

      // Register HTTP routes
      registerNotifyRoutes(app, {
        db,
        sendNotify: async (title: string, body: string, channelName?: string) => {
          let targets: Channel[]
          if (channelName) {
            const ch = await ctx.call<Channel>('channel.' + channelName).catch(() => null)
            targets = ch ? [ch] : []
          } else {
            targets = await ctx.call<Channel[]>('channel.list').catch(() => [] as Channel[])
          }
          if (targets.length === 0) {
            throw new Error('No notification channels configured')
          }
          for (const ch of targets) {
            await ch.send({
              type: 'text',
              content: `**${title}**\n\n${body}`,
              metadata: { event: 'notify.manual' },
            })
          }
        },
      })

      for (const event of SUBSCRIBED_EVENTS) {
        const unsub = ctx.on(event, async (data: unknown) => {
          const obj = data as Record<string, unknown> | undefined
          const urgency = (obj?.urgency as string) ?? 'important'
          const title = (obj?.jobName ?? obj?.title ?? event) as string
          const content = formatEventContent(event, data)

          // DND check — urgent events break through
          const dndUntil = getDndUntil(db)
          if (dndUntil && new Date() < new Date(dndUntil) && urgency !== 'urgent') {
            ctx.logger.info(`[notify] event "${event}" suppressed by DND (until ${dndUntil})`)
            if (db) {
              logNotification(db, {
                channel: 'suppressed',
                eventType: event,
                title,
                status: 'dnd_suppressed',
              })
            }
            return
          }

          const channels = await ctx.call<Channel[]>('channel.list').catch(() => [] as Channel[])
          ctx.logger.info(`[notify] event "${event}" (urgency: ${urgency}) → dispatching to ${channels.length} channel(s)`)

          for (const channel of channels) {
            // info-level events only go to web-notify channel
            if (urgency === 'info' && channel.name !== 'web-notify') continue

            try {
              ctx.logger.info(`[notify] sending to channel "${channel.name}" (event: ${event}, title: ${title})`)
              await channel.send({
                type: 'text',
                content,
                metadata: { event, urgency },
              })
              ctx.logger.info(`[notify] sent to "${channel.name}" OK`)
              if (db) {
                logNotification(db, {
                  channel: channel.name,
                  eventType: event,
                  title,
                  status: 'success',
                })
              }
            } catch (err) {
              ctx.logger.error(`[notify] send to "${channel.name}" FAILED: ${(err as Error).message}`)
              if (db) {
                logNotification(db, {
                  channel: channel.name,
                  eventType: event,
                  title,
                  status: 'failed',
                  errorMsg: (err as Error).message,
                })
              }
            }
          }
        })
        unsubs.push(unsub)
      }

      ctx.logger.info('Notify plugin initialized')
    },

    async stop() {
      for (const unsub of unsubs) unsub()
      unsubs.length = 0
    },
  }
}

// ── Capability Accessor ───────────────────────────────────

/**
 * Retrieve the event logger function via the capability system.
 * The notify plugin must be initialized before calling this.
 */
export async function getEventLogger(ctx: PluginContext): Promise<LogEventFn> {
  return ctx.call<LogEventFn>('event.log')
}

// ── Re-exports ────────────────────────────────────────────

export { logNotification, listNotifications } from './notification-log.js'
export type { NotificationLogEntry } from './notification-log.js'
export { registerNotifyRoutes } from './routes.js'
export type { NotifyRouteDeps } from './routes.js'
export { logEvent, listEvents } from './event-log.js'
export type { EventLogEntry, EventLogInput } from './event-log.js'
