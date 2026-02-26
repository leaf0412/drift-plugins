import type { DriftToolRegistration, DriftToolResult } from '@drift/core'
import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import dayjs from 'dayjs'

type ToolRegistration = Omit<DriftToolRegistration, 'pluginId' | 'source'>

interface MemoryRow {
  id: string
  project: string
  type: string
  key: string
  value: string
  created_at: string
  updated_at: string
}

/**
 * Build the 2 memory tool definitions for ctx.registerTool().
 *
 * - memory_save  — upsert a structured fact into the memory table
 * - memory_list  — query saved memories with optional filters
 */
export function buildMemoryTools(db: Database.Database): ToolRegistration[] {
  return [
    // ── memory_save ────────────────────────────────────────────
    {
      name: 'memory_save',
      description:
        'Save a structured fact to long-term memory. Upserts on (project, type, key) — if the same combination exists, the value is updated.',
      parametersSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['preference', 'fact', 'decision', 'event'],
            description: 'Category of the memory entry',
          },
          key: {
            type: 'string',
            description: 'Short identifier for this memory, e.g. "preferred-editor" or "deploy-target"',
          },
          value: {
            type: 'string',
            description: 'The content / detail of the memory',
          },
          project: {
            type: 'string',
            description: 'Optional project scope. Defaults to empty string (global).',
          },
        },
        required: ['type', 'key', 'value'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        try {
          const { type, key, value, project } = args as {
            type: string
            key: string
            value: string
            project?: string
          }

          if (!key) {
            return { success: false, output: '', error: 'key must not be empty' }
          }
          if (!value) {
            return { success: false, output: '', error: 'value must not be empty' }
          }

          const id = nanoid()
          const now = dayjs().toISOString()
          const proj = project ?? ''

          db.prepare(
            `INSERT INTO memory (id, project, type, key, value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project, type, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          ).run(id, proj, type, key, value, now, now)

          return {
            success: true,
            output: `Saved memory: [${type}] ${key} = ${value}`,
          }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },

    // ── memory_list ────────────────────────────────────────────
    {
      name: 'memory_list',
      description:
        'List saved memories with optional filters. Returns entries ordered by most recently updated. Excludes internal project_scan entries.',
      parametersSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Filter by memory type (preference, fact, decision, event)',
          },
          q: {
            type: 'string',
            description: 'Keyword search across key and value fields',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of entries to return (default: 20)',
          },
        },
        required: [],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        try {
          const { type, q, limit } = args as {
            type?: string
            q?: string
            limit?: number
          }

          let sql = `SELECT * FROM memory WHERE type != 'project_scan'`
          const conditions: string[] = []
          const params: unknown[] = []

          if (type) {
            conditions.push(`type = ?`)
            params.push(type)
          }
          if (q) {
            const escaped = q.replace(/[%_\\]/g, '\\$&')
            conditions.push(`(key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')`)
            params.push(`%${escaped}%`, `%${escaped}%`)
          }

          if (conditions.length > 0) {
            sql += ` AND ${conditions.join(' AND ')}`
          }
          sql += ` ORDER BY updated_at DESC LIMIT ?`
          params.push(limit ?? 20)

          const rows = db.prepare(sql).all(...params) as MemoryRow[]

          const entries = rows.map((r) => ({
            id: r.id,
            project: r.project,
            type: r.type,
            key: r.key,
            value: r.value,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }))

          return { success: true, output: JSON.stringify(entries) }
        } catch (err) {
          return { success: false, output: '', error: String(err) }
        }
      },
    },
  ]
}
