import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { getStorageDb, getHttpApp } from '@drift/plugins'
import { registerTaskRoutes } from './routes.js'
import { buildTaskTools } from './tools.js'
import { checkReminders } from './reminder.js'

// ── Manifest ──────────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'task',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    routes: ['/api/tasks', '/api/tasks/:id'],
    events: { emit: ['task.reminder', 'task.created', 'task.completed'] },
  },
  depends: ['storage', 'http', 'notify'],
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the task plugin that owns task CRUD, HTTP routes,
 * agent tools, and periodic reminder checking.
 */
export function createTaskPlugin(): DriftPlugin {
  let timer: ReturnType<typeof setInterval> | null = null
  let savedCtx: PluginContext | null = null

  return {
    manifest,

    async init(ctx: PluginContext) {
      savedCtx = ctx
      const db = getStorageDb(ctx)
      const app = getHttpApp(ctx)

      registerTaskRoutes(app, db)

      // Register agent tools via PluginRegistry
      if (ctx.registerTool) {
        const tools = buildTaskTools(db)
        for (const tool of tools) {
          ctx.registerTool(tool)
        }
        ctx.logger.debug(`Task: ${tools.length} tools registered via ctx.registerTool`)
      }

      ctx.logger.info('Task plugin initialized')
    },

    async start() {
      const ctx = savedCtx!
      const db = getStorageDb(ctx)

      timer = setInterval(async () => {
        try {
          const count = await checkReminders(db, ctx.events.emit.bind(ctx.events))
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
