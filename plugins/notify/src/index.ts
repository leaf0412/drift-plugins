import type { DriftPlugin, PluginContext } from '@drift/core'
import type Database from 'better-sqlite3'
import type { Hono } from 'hono'
import type { Channel } from '@drift/core'
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

const SUBSCRIBED_EVENTS = ['chat.complete', 'cron.result', 'cron.notify', 'cron.chat', 'task.reminder'] as const

// ── Context helpers ──────────────────────────────────────

type AnyCtx = PluginContext & Record<string, unknown>

async function getDbFromCtx(ctx: AnyCtx): Promise<Database.Database> {
  if (typeof ctx['call'] === 'function') {
    return (ctx['call'] as <T>(cap: string) => Promise<T>)<Database.Database>('sqlite.db')
  }
  const atoms = ctx['atoms'] as { atom<T>(k: string, d: T): { deref(): T } } | undefined
  const db = atoms?.atom<Database.Database | null>('storage.db', null)?.deref()
  if (!db) throw new Error('Storage plugin not initialized')
  return db
}

async function getHttpFromCtx(ctx: AnyCtx): Promise<Hono> {
  if (typeof ctx['call'] === 'function') {
    const pluginId = ctx['pluginId'] as string | undefined
    return (ctx['call'] as <T>(cap: string, data?: unknown) => Promise<T>)<Hono>('http.app', { pluginId })
  }
  const atoms = ctx['atoms'] as { atom<T>(k: string, d: T): { deref(): T } } | undefined
  const app = atoms?.atom<Hono | null>('http.app', null)?.deref()
  if (!app) throw new Error('HTTP plugin not initialized')
  return app
}

function subscribeEvent(ctx: AnyCtx, event: string, handler: (data: unknown) => Promise<void>): () => void {
  // New-style kernel context: ctx.on(event, handler)
  if (typeof ctx['on'] === 'function') {
    return (ctx['on'] as (event: string, handler: (data: unknown) => void) => () => void)(event, handler)
  }
  // Old-style external-kernel context: ctx.events.on(event, handler)
  const events = ctx['events'] as { on(event: string, handler: (data: unknown) => void): () => void } | undefined
  if (events && typeof events.on === 'function') {
    return events.on(event, handler)
  }
  return () => {}
}

async function getChannels(ctx: AnyCtx): Promise<Channel[]> {
  if (typeof ctx['call'] === 'function') {
    return (ctx['call'] as <T>(cap: string) => Promise<T>)<Channel[]>('channel.list').catch(() => [] as Channel[])
  }
  const channels = ctx['channels'] as { list(): Channel[] } | undefined
  return channels?.list() ?? []
}

async function getChannelByName(ctx: AnyCtx, name: string): Promise<Channel | null> {
  if (typeof ctx['call'] === 'function') {
    return (ctx['call'] as <T>(cap: string) => Promise<T>)<Channel>('channel.' + name).catch(() => null)
  }
  const channels = ctx['channels'] as { get(name: string): Channel | undefined } | undefined
  return channels?.get(name) ?? null
}

function publishEventLogCapability(ctx: AnyCtx, fn: LogEventFn): void {
  if (typeof ctx['register'] === 'function') {
    ;(ctx['register'] as (name: string, handler: (data: unknown) => unknown) => void)('event.log', (data: unknown) => fn(data as EventLogInput))
  } else {
    // Old-style: publish via atom
    const atoms = ctx['atoms'] as { atom<T>(k: string, d: T): { reset(v: T): T } } | undefined
    if (atoms) {
      atoms.atom<LogEventFn>('event.log', (() => { throw new Error('event.log not initialized') }) as unknown as LogEventFn)
        .reset(fn)
    }
  }
}

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

  return {
    name: 'notify',
    manifest: {
      name: 'notify',
      version: '1.0.0',
      type: 'code',
      capabilities: {
        events: {
          listen: ['chat.complete', 'cron.result', 'cron.notify', 'cron.chat', 'task.reminder'],
        },
      },
      depends: ['storage', 'http'],
    },

    async init(ctx: PluginContext) {
      const anyCtx = ctx as AnyCtx
      const db = await getDbFromCtx(anyCtx)
      const app = await getHttpFromCtx(anyCtx)

      // Publish event.log capability (new-style: ctx.register; old-style: atoms)
      const logEventFn: LogEventFn = (input) => logEvent(db, input)
      publishEventLogCapability(anyCtx, logEventFn)

      // Register HTTP routes
      registerNotifyRoutes(app, {
        db,
        sendNotify: async (title: string, body: string, channelName?: string) => {
          let targets: Channel[]
          if (channelName) {
            const ch = await getChannelByName(anyCtx, channelName)
            targets = ch ? [ch] : []
          } else {
            targets = await getChannels(anyCtx)
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
        const unsub = subscribeEvent(anyCtx, event, async (data) => {
          const channels = await getChannels(anyCtx)
          for (const channel of channels) {
            const obj = data as Record<string, unknown> | undefined
            const title = obj?.jobName as string ?? obj?.title as string ?? event
            const content = formatEventContent(event, data)
            try {
              await channel.send({
                type: 'text',
                content,
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
  } as DriftPlugin
}

// ── Capability Accessor ───────────────────────────────────

/**
 * Retrieve the event logger function via the capability system.
 * The notify plugin must be initialized before calling this.
 * New-style: uses ctx.call('event.log'); old-style: reads from atom.
 */
export async function getEventLogger(ctx: PluginContext): Promise<LogEventFn> {
  const anyCtx = ctx as AnyCtx
  if (typeof anyCtx['call'] === 'function') {
    return (anyCtx['call'] as <T>(cap: string) => Promise<T>)<LogEventFn>('event.log')
  }
  // Old-style: read from atom
  const atoms = anyCtx['atoms'] as { atom<T>(k: string, d: T): { deref(): T } } | undefined
  const fn = atoms?.atom<LogEventFn>('event.log', (() => { throw new Error('event.log not initialized') }) as unknown as LogEventFn)?.deref()
  if (!fn) throw new Error('event.log not initialized')
  return fn
}

// ── Re-exports ────────────────────────────────────────────

export { logNotification, listNotifications } from './notification-log.js'
export type { NotificationLogEntry } from './notification-log.js'
export { registerNotifyRoutes } from './routes.js'
export type { NotifyRouteDeps } from './routes.js'
export { logEvent, listEvents } from './event-log.js'
export type { EventLogEntry, EventLogInput } from './event-log.js'
