import type { DriftToolRegistration, DriftToolResult } from '@drift/core'
import type Database from 'better-sqlite3'
import {
  createTask,
  listTasks,
  updateTask,
  deleteTask,
} from './service.js'

type ToolRegistration = Omit<DriftToolRegistration, 'pluginId' | 'source'>

/**
 * Build 4 task tool definitions for ctx.register('tool.<name>', handler).
 *
 * - task_create  — create a new task
 * - task_list    — list tasks with optional filters
 * - task_update  — update an existing task by ID
 * - task_delete  — delete a task by ID
 */
export function buildTaskTools(db: Database.Database): ToolRegistration[] {
  return [
    // ── task_create ──────────────────────────────────────────
    {
      name: 'task_create',
      description:
        'Create a new task (passive todo item). Tasks are NOT automatically executed on a schedule — for scheduled auto-execution, create an agent file in mind/agents/ instead. Returns the created task as JSON.',
      parametersSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Task title (required)',
          },
          description: {
            type: 'string',
            description: 'Detailed description of the task',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Priority level (default: medium)',
          },
          due_at: {
            type: 'string',
            description: 'ISO 8601 due date, e.g. "2026-03-01T10:00:00.000Z"',
          },
          reminder_at: {
            type: 'string',
            description: 'ISO 8601 reminder time, triggers notification when reached',
          },
          recurrence: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'Recurrence pattern. When the task is manually marked as done, a new pending copy is created. This does NOT auto-execute the task on a schedule.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorisation',
          },
        },
        required: ['title'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        try {
          const { title, description, priority, due_at, reminder_at, recurrence, tags } =
            args as {
              title?: string
              description?: string
              priority?: string
              due_at?: string
              reminder_at?: string
              recurrence?: string
              tags?: string[]
            }

          if (!title) {
            return { success: false, output: '', error: 'title is required' }
          }

          const task = createTask(db, {
            title,
            description,
            priority,
            due_at,
            reminder_at,
            recurrence,
            tags,
          })

          return { success: true, output: JSON.stringify(task) }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },

    // ── task_list ────────────────────────────────────────────
    {
      name: 'task_list',
      description:
        'List tasks with optional filters. Returns a JSON array ordered by most recently created.',
      parametersSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'cancelled'],
            description: 'Filter by task status',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Filter by priority level',
          },
          tag: {
            type: 'string',
            description: 'Filter by tag name',
          },
          due_before: {
            type: 'string',
            description: 'Only tasks due before this ISO 8601 date',
          },
          due_after: {
            type: 'string',
            description: 'Only tasks due after this ISO 8601 date',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of tasks to return',
          },
        },
        required: [],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        try {
          const { status, priority, tag, due_before, due_after, limit } =
            args as {
              status?: string
              priority?: string
              tag?: string
              due_before?: string
              due_after?: string
              limit?: number
            }

          const tasks = listTasks(db, { status, priority, tag, due_before, due_after, limit })
          return { success: true, output: JSON.stringify(tasks) }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },

    // ── task_update ──────────────────────────────────────────
    {
      name: 'task_update',
      description:
        'Update an existing task by ID. Only provided fields are changed. Returns the updated task as JSON.',
      parametersSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Task ID (required)',
          },
          title: {
            type: 'string',
            description: 'New title',
          },
          description: {
            type: 'string',
            description: 'New description',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'cancelled'],
            description: 'New status',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'New priority',
          },
          due_at: {
            type: 'string',
            description: 'New due date (ISO 8601)',
          },
          reminder_at: {
            type: 'string',
            description: 'New reminder time (ISO 8601)',
          },
          recurrence: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'New recurrence pattern',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replace tags',
          },
        },
        required: ['id'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        try {
          const { id, ...fields } = args as {
            id?: string
            title?: string
            description?: string
            status?: string
            priority?: string
            due_at?: string
            reminder_at?: string
            recurrence?: string
            tags?: string[]
          }

          if (!id) {
            return { success: false, output: '', error: 'id is required' }
          }

          const updated = updateTask(db, id, fields)
          if (!updated) {
            return { success: false, output: '', error: `Task not found: ${id}` }
          }

          return { success: true, output: JSON.stringify(updated) }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },

    // ── task_delete ──────────────────────────────────────────
    {
      name: 'task_delete',
      description:
        'Delete a task by ID. Returns "Deleted" on success.',
      parametersSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Task ID to delete (required)',
          },
        },
        required: ['id'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        try {
          const { id } = args as { id?: string }

          if (!id) {
            return { success: false, output: '', error: 'id is required' }
          }

          const deleted = deleteTask(db, id)
          if (!deleted) {
            return { success: false, output: '', error: `Task not found: ${id}` }
          }

          return { success: true, output: 'Deleted' }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },
  ]
}
