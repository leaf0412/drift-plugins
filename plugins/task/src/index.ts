import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { registerTaskRoutes } from './routes.js'
import { buildTaskTools } from './tools.js'
import { checkReminders } from './reminder.js'

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the task plugin that owns task CRUD, HTTP routes,
 * agent tools, and periodic reminder checking.
 */
export function createTaskPlugin(): DriftPlugin {
  let timer: ReturnType<typeof setInterval> | null = null
  let savedCtx: PluginContext | null = null
  let db: Database.Database | null = null

  return {
    name: 'task',
    requiresCapabilities: ['sqlite.db', 'http.app'],
    tools: buildTaskTools(() => db!),

    async init(ctx: PluginContext) {
      savedCtx = ctx
      db = await ctx.call<Database.Database>('sqlite.db')
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })

      registerTaskRoutes(app, db)

      ctx.logger.info('Task plugin initialized')
    },

    async start() {
      const ctx = savedCtx!

      timer = setInterval(async () => {
        try {
          const count = await checkReminders(db!, ctx.emit.bind(ctx))
          if (count > 0) {
            ctx.logger.info(`Task: ${count} reminder(s) sent`)
          }
        } catch (err) {
          ctx.logger.error(`Task: reminder check failed: ${err}`)
        }
      }, 60_000)

      ctx.logger.info('Task plugin started (reminder interval: 60s)')
    },

    async stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

export default createTaskPlugin

// ── Re-exports ────────────────────────────────────────────

export {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  getDueReminders,
  markNotified,
  createNextRecurrence,
} from './service.js'
export type { Task, CreateTaskInput, UpdateTaskInput, ListTasksFilter } from './service.js'
export { buildTaskTools } from './tools.js'
export { checkReminders } from './reminder.js'
export { registerTaskRoutes } from './routes.js'
