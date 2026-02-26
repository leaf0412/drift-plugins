import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { getStorageDb, getHttpApp } from '@drift/plugins'
import { logNotification, listNotifications } from './notification-log.js'
import { registerNotifyRoutes } from './routes.js'
import { logEvent } from './event-log.js'
import type { EventLogInput } from './event-log.js'

// ── Manifest ──────────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'notify',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    events: {
      listen: ['chat.complete', 'cron.result', 'cron.notify', 'cron.chat', 'task.reminder'],
    },
  },
  depends: ['storage', 'http'],
}

// ── Atom Key ──────────────────────────────────────────────

const EVENT_LOG_ATOM = 'event.log'

type LogEventFn = (input: EventLogInput) => import('./event-log.js').EventLogEntry

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the notification dispatcher plugin.
 *
 * On each subscribed event, broadcasts the payload to every registered Channel
 * and logs success/failure to the notification_log table.
 *
 * Publishes the `event.log` atom so other plugins can log events.
 */
export function createNotifyPlugin(): DriftPlugin {
  const unsubs: Array<() => void> = []

  return {
    manifest,

    async init(ctx: PluginContext) {
      const db = getStorageDb(ctx)
      const app = getHttpApp(ctx)

      // Publish event.log atom
      const logEventFn: LogEventFn = (input) => logEvent(db, input)
      ctx.atoms
        .atom<LogEventFn>(EVENT_LOG_ATOM, (() => { throw new Error('event.log not initialized') }) as unknown as LogEventFn)
        .reset(logEventFn)

      // Register HTTP routes
      registerNotifyRoutes(app, {
        db,
        sendNotify: async (title: string, body: string, channelName?: string) => {
          const targets = channelName
            ? (() => { const ch = ctx.channels.get(channelName); return ch ? [ch] : [] })()
            : ctx.channels.list()
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

      const events = manifest.capabilities.events!.listen!

      for (const event of events) {
        const unsub = ctx.events.on(event, async (data) => {
          const channels = ctx.channels.list()
          for (const channel of channels) {
            const title =
              (data as Record<string, unknown>)?.jobName as string ??
              (data as Record<string, unknown>)?.title as string ??
              event
            try {
              await channel.send({
                type: 'text',
                content: typeof data === 'string' ? data : JSON.stringify(data),
                metadata: { event },
              })
              logNotification(db, {
                channel: channel.name,
                eventType: event,
                title,
                status: 'success',
              })
            } catch (err) {
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

// ── Atom Accessor ────────────────────────────────────────

/**
 * Retrieve the event logger function from the atom registry.
 * The notify plugin must be initialized before calling this.
 */
export function getEventLogger(ctx: PluginContext): LogEventFn {
  return ctx.atoms
    .atom<LogEventFn>(EVENT_LOG_ATOM, (() => { throw new Error('event.log not initialized') }) as unknown as LogEventFn)
    .deref()
}

// ── Re-exports ────────────────────────────────────────────

export { logNotification, listNotifications } from './notification-log.js'
export type { NotificationLogEntry } from './notification-log.js'
export { registerNotifyRoutes } from './routes.js'
export type { NotifyRouteDeps } from './routes.js'
export { logEvent, listEvents } from './event-log.js'
export type { EventLogEntry, EventLogInput } from './event-log.js'
