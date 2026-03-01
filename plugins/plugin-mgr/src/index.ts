// plugin-mgr/index.ts — Plugin Manager: Agent tools for CRUD on user plugins
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { scanPluginDirs } from '@drift/core'
import type { DriftToolResult } from '@drift/core'
import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { PluginMgrOptions, PluginInfo } from './types.js'

export type { PluginMgrOptions, PluginInfo } from './types.js'

// ── Tool Registration Helper Type ─────────────────────────────

interface ToolRegistration {
  name: string
  description: string
  parametersSchema: Record<string, unknown>
  execute: (args: unknown) => Promise<DriftToolResult>
}


// ── Tool Builders ─────────────────────────────────────────────

type EmitFn = (event: string, data?: unknown) => Promise<void> | void

function buildTools(
  options: PluginMgrOptions,
  emitFn: EmitFn,
): ToolRegistration[] {
  const { pluginsDir, builtinNames } = options

  function isBuiltin(name: string): boolean {
    return builtinNames.includes(name)
  }

  function pluginDir(name: string): string {
    return join(pluginsDir, name)
  }

  return [
    // ── plugin_create ─────────────────────────────────────────
    {
      name: 'plugin_create',
      description: `Create a new user plugin. Two types available:

**Declarative** (for HTTP API calls) — content must use this EXACT format:
\`\`\`
---
name: my-plugin
version: 0.1.0
type: declarative
capabilities:
  tools: [tool_name]
---

# tool_name

Tool description.

## Parameters
- city: string (required) — City name
- units: string — Units (optional)

## Action
GET https://api.example.com/data?city=\${city}&units=\${units}

## Extract
temperature: data.temperature
condition: data.condition
\`\`\`
Rules: YAML frontmatter between --- is required. Each # heading = one tool. ## Action = HTTP request (required, supports \${param} substitution). ## Parameters = tool parameters. ## Extract = JSON dot-path extraction (optional). Do NOT use triggers/steps/prompt/config sections — they don't exist.

**Code** (for complex logic) — content is index.ts, must default-export a factory:
\`\`\`typescript
import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
export default function create(): DriftPlugin {
  return {
    name: 'x',
    async init(ctx: PluginContext) {
      ctx.register('tool.my_tool', async (data) => ({ success: true, output: 'result' }))
    },
  }
}
\`\`\`
Wrong imports: @drift/agent, @drift-coach/core do NOT exist. Wrong APIs: ctx.output(), ctx.memory.save() do NOT exist.`,
      parametersSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name (kebab-case, e.g. "weather-query")' },
          type: { type: 'string', enum: ['declarative', 'code'], description: 'declarative = HTTP API tools (plugin.md), code = TypeScript logic (plugin.yaml + index.ts)' },
          content: { type: 'string', description: 'For declarative: full plugin.md with YAML frontmatter + # tool sections. For code: index.ts with default export factory function.' },
          manifest: { type: 'string', description: 'For code plugins only: plugin.yaml content. Ignored for declarative.' },
        },
        required: ['name', 'type', 'content'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        const { name, type, content, manifest: yamlContent } = args as {
          name: string; type: 'declarative' | 'code'; content: string; manifest?: string
        }

        if (isBuiltin(name)) {
          return { success: false, output: '', error: `Cannot create plugin "${name}": conflicts with builtin plugin` }
        }

        const dir = pluginDir(name)
        if (existsSync(dir)) {
          return { success: false, output: '', error: `Plugin "${name}" already exists` }
        }

        mkdirSync(dir, { recursive: true })

        if (type === 'declarative') {
          writeFileSync(join(dir, 'plugin.md'), content, 'utf-8')
        } else {
          // Code plugin: write index.ts and plugin.yaml
          writeFileSync(join(dir, 'index.ts'), content, 'utf-8')
          const yaml = yamlContent || `name: ${name}\nversion: 0.1.0\ntype: code\ncapabilities: {}\n`
          writeFileSync(join(dir, 'plugin.yaml'), yaml, 'utf-8')
        }

        await emitFn('plugin.created', { name, type })
        return { success: true, output: `Plugin "${name}" created (${type}) at ${dir}` }
      },
    },

    // ── plugin_list ───────────────────────────────────────────
    {
      name: 'plugin_list',
      description: 'List all user plugins in the plugins directory. Returns JSON array of plugin info.',
      parametersSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute(): Promise<DriftToolResult> {
        if (!existsSync(pluginsDir)) {
          return { success: true, output: JSON.stringify([]) }
        }

        const scanned = scanPluginDirs([pluginsDir])
        const infos: PluginInfo[] = scanned.map(s => ({
          name: s.manifest.name,
          version: s.manifest.version,
          type: s.manifest.type,
          builtin: isBuiltin(s.manifest.name),
          dir: s.dir,
          toolCount: s.declarative?.tools.length,
        }))

        return { success: true, output: JSON.stringify(infos) }
      },
    },

    // ── plugin_read ───────────────────────────────────────────
    {
      name: 'plugin_read',
      description: 'Read the source files of a user plugin. Returns plugin.md for declarative or plugin.yaml + index.ts for code plugins.',
      parametersSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name' },
        },
        required: ['name'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        const { name } = args as { name: string }
        const dir = pluginDir(name)

        if (!existsSync(dir)) {
          return { success: false, output: '', error: `Plugin "${name}" not found` }
        }

        const mdPath = join(dir, 'plugin.md')
        if (existsSync(mdPath)) {
          const content = readFileSync(mdPath, 'utf-8')
          return { success: true, output: JSON.stringify({ type: 'declarative', 'plugin.md': content }) }
        }

        const yamlPath = join(dir, 'plugin.yaml')
        const tsPath = join(dir, 'index.ts')
        const result: Record<string, string> = { type: 'code' }
        if (existsSync(yamlPath)) result['plugin.yaml'] = readFileSync(yamlPath, 'utf-8')
        if (existsSync(tsPath)) result['index.ts'] = readFileSync(tsPath, 'utf-8')

        if (!result['plugin.yaml'] && !result['index.ts']) {
          return { success: false, output: '', error: `Plugin "${name}" has no recognized files` }
        }

        return { success: true, output: JSON.stringify(result) }
      },
    },

    // ── plugin_update ─────────────────────────────────────────
    {
      name: 'plugin_update',
      description: 'Update an existing user plugin. Overwrites plugin.md for declarative or index.ts for code plugins.',
      parametersSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name' },
          content: { type: 'string', description: 'New content for the main plugin file' },
        },
        required: ['name', 'content'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        const { name, content } = args as { name: string; content: string }

        if (isBuiltin(name)) {
          return { success: false, output: '', error: `Cannot update builtin plugin "${name}"` }
        }

        const dir = pluginDir(name)
        if (!existsSync(dir)) {
          return { success: false, output: '', error: `Plugin "${name}" not found` }
        }

        // Detect type by existing files
        const mdPath = join(dir, 'plugin.md')
        if (existsSync(mdPath)) {
          writeFileSync(mdPath, content, 'utf-8')
          await emitFn('plugin.updated', { name, type: 'declarative' })
          return { success: true, output: `Plugin "${name}" updated (declarative)` }
        }

        const tsPath = join(dir, 'index.ts')
        if (existsSync(tsPath)) {
          writeFileSync(tsPath, content, 'utf-8')
          await emitFn('plugin.updated', { name, type: 'code' })
          return { success: true, output: `Plugin "${name}" updated (code)` }
        }

        return { success: false, output: '', error: `Plugin "${name}" has no recognized files to update` }
      },
    },

    // ── plugin_delete ─────────────────────────────────────────
    {
      name: 'plugin_delete',
      description: 'Delete a user plugin directory. Cannot delete builtin plugins.',
      parametersSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name' },
        },
        required: ['name'],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        const { name } = args as { name: string }

        if (isBuiltin(name)) {
          return { success: false, output: '', error: `Cannot delete builtin plugin "${name}"` }
        }

        const dir = pluginDir(name)
        if (!existsSync(dir)) {
          return { success: false, output: '', error: `Plugin "${name}" not found` }
        }

        rmSync(dir, { recursive: true, force: true })
        await emitFn('plugin.deleted', { name })
        return { success: true, output: `Plugin "${name}" deleted` }
      },
    },

    // ── plugin_reload ────────────────────────────────────────
    {
      name: 'plugin_reload',
      description: 'Hot-reload a plugin or all plugins without restarting the daemon. Stops the old instance, clears cache, re-loads from disk, and re-initializes.',
      parametersSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name to reload. Omit to reload ALL external plugins.' },
        },
        required: [],
      },
      async execute(args: unknown): Promise<DriftToolResult> {
        const { name } = (args as { name?: string }) || {}

        if (name) {
          if (isBuiltin(name)) {
            return { success: false, output: '', error: `Cannot reload builtin plugin "${name}"` }
          }
          await emitFn('plugin.reload', { name })
          return { success: true, output: `Reload triggered for plugin "${name}"` }
        }

        // Reload all
        await emitFn('plugin.reload-all', {})
        return { success: true, output: 'Reload triggered for all external plugins' }
      },
    },
  ]
}

// ── Plugin Factory ────────────────────────────────────────────

export function createPluginMgrPlugin(options?: PluginMgrOptions): DriftPlugin {
  const opts: PluginMgrOptions = options ?? {
    pluginsDir: join(process.env.DRIFT_DATA_DIR || join(process.env.HOME || '/tmp', '.drift'), 'plugins'),
    builtinNames: [],
  }
  return {
    name: 'plugin-mgr',

    async init(ctx: PluginContext) {
      // Ensure plugins directory exists
      if (!existsSync(opts.pluginsDir)) {
        mkdirSync(opts.pluginsDir, { recursive: true })
      }

      const tools = buildTools(opts, (event, data) => ctx.emit(event, data))
      for (const tool of tools) {
        ctx.register(`tool.${tool.name}`, async (data: unknown) => tool.execute(data))
      }

      ctx.logger.info(`plugin-mgr: ${tools.length} tools registered`)
    },
  }
}

export default createPluginMgrPlugin
