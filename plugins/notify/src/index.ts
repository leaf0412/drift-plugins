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

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the notification dispatcher plugin.
 *
 * On each subscribed event, broadcasts the payload to every registered Channel
 * and logs success/failure to the notification_log table.
 *
 * Publishes the `event.log` capability so other plugins can log events.
 */
export function createNotifyPlugin(): DriftPlugin {
  const unsubs: Array<() => void> = []
  let db: Database.Database | null = null

  return {
    name: 'notify',
    version: '1.1.0',
    requiresCapabilities: ['sqlite.db', 'http.app'],
    capabilities: {
      'event.log': (data) => logEvent(db!, data as EventLogInput),
    },

    async init(ctx: PluginContext) {
      db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

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
          const channels = await ctx.call<Channel[]>('channel.list').catch(() => [] as Channel[])
          ctx.logger.info(`[notify] event "${event}" → dispatching to ${channels.length} channel(s)`)
          for (const channel of channels) {
            const obj = data as Record<string, unknown> | undefined
            const title = obj?.jobName as string ?? obj?.title as string ?? event
            const content = formatEventContent(event, data)
            try {
              ctx.logger.info(`[notify] sending to channel "${channel.name}" (event: ${event}, title: ${title})`)
              await channel.send({
                type: 'text',
                content,
                metadata: { event },
              })
              ctx.logger.info(`[notify] sent to "${channel.name}" OK`)
              logNotification(db, {
                channel: channel.name,
                eventType: event,
                title,
                status: 'success',
              })
            } catch (err) {
              ctx.logger.error(`[notify] send to "${channel.name}" FAILED: ${(err as Error).message}`)
              logNotification(db, {
                channel: channel.name,
                eventType: event,
                title,
                status: 'failed',
                errorMsg: (err as Error).message,
              })
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
