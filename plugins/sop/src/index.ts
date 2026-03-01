// sop/index.ts — SOP plugin factory
import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSopFile } from './parser.js'
import { SopExecutor } from './executor.js'
import type { Sop } from './types.js'

// ── Manifest ──────────────────────────────────────────────────

const manifest = {
  name: 'sop',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    tools: ['sop_list', 'sop_run', 'sop_status', 'sop_advance'],
    events: { emit: ['sop.started', 'sop.step_completed', 'sop.completed', 'sop.failed', 'sop.paused'] },
  },
  depends: [],
}

// ── Registry Helpers ─────────────────────────────────────────

function loadSopsFromDir(sopDir: string, logger: PluginContext['logger']): Map<string, Sop> {
  const registry = new Map<string, Sop>()

  if (!existsSync(sopDir)) {
    mkdirSync(sopDir, { recursive: true })
    return registry
  }

  const entries = readdirSync(sopDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = join(sopDir, entry.name)
    try {
      const sop = parseSopFile(filePath)
      registry.set(sop.slug, sop)
      logger.debug(`SOP loaded: ${sop.slug} (${sop.steps.length} steps)`)
    } catch (err) {
      logger.error(`Failed to parse SOP file ${entry.name}:`, err)
    }
  }

  return registry
}

// ── Tool Builders ─────────────────────────────────────────────

interface SopToolDef {
  name: string
  description: string
  parametersSchema: Record<string, unknown>
  execute: (args: unknown) => Promise<{ success: boolean; output: string; error?: string }>
}

type EmitFn = (event: string, data?: unknown) => Promise<void> | void

function buildSopTools(
  getRegistry: () => Map<string, Sop>,
  executor: SopExecutor,
  emitFn: EmitFn,
): SopToolDef[] {
  return [
    // sop_list — list all available SOPs
    {
      name: 'sop_list',
      description: 'List all available SOPs (Standard Operating Procedures) loaded from the mind/sops directory.',
      parametersSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute() {
        const registry = getRegistry()
        const sops = [...registry.values()].map(sop => ({
          slug: sop.slug,
          name: sop.name,
          steps: sop.steps.length,
          executionMode: sop.executionMode,
          enabled: sop.enabled,
          triggers: sop.triggers,
        }))
        return { success: true, output: JSON.stringify(sops) }
      },
    },

    // sop_run — start executing a SOP by slug
    {
      name: 'sop_run',
      description: 'Start executing a SOP. Returns the execution ID and initial status. For step_by_step or supervised mode, the execution may pause requiring sop_advance.',
      parametersSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'SOP slug (filename without .md extension)' },
        },
        required: ['slug'],
      },
      async execute(args: unknown) {
        const { slug } = args as { slug: string }
        const registry = getRegistry()
        const sop = registry.get(slug)
        if (!sop) {
          return { success: false, output: '', error: `SOP not found: ${slug}` }
        }

        const exec = executor.start(sop)
        await emitFn('sop.started', { sopSlug: sop.slug, executionId: exec.id })

        // No-op step runner — in real usage this would be injected by the agent plugin
        // The executor state machine advances; actual LLM execution is done externally
        const noopRunner = async () => ({ output: '(queued for execution)' })
        const result = await executor.run(exec.id, sop, noopRunner)

        if (result.status === 'completed') {
          await emitFn('sop.completed', { sopSlug: sop.slug, executionId: exec.id })
        } else if (result.status === 'failed') {
          await emitFn('sop.failed', { sopSlug: sop.slug, executionId: exec.id, reason: result.failureReason })
        } else if (result.status === 'awaiting_approval') {
          await emitFn('sop.paused', { sopSlug: sop.slug, executionId: exec.id, currentStep: result.currentStep })
        }

        return { success: true, output: JSON.stringify(result) }
      },
    },

    // sop_status — get status of an execution
    {
      name: 'sop_status',
      description: 'Get the current status of a SOP execution by its execution ID.',
      parametersSchema: {
        type: 'object',
        properties: {
          executionId: { type: 'string', description: 'Execution ID returned by sop_run' },
        },
        required: ['executionId'],
      },
      async execute(args: unknown) {
        const { executionId } = args as { executionId: string }
        const exec = executor.getExecution(executionId)
        if (!exec) {
          return { success: false, output: '', error: `Execution not found: ${executionId}` }
        }
        return { success: true, output: JSON.stringify(exec) }
      },
    },

    // sop_advance — advance a paused execution
    {
      name: 'sop_advance',
      description: 'Advance a paused SOP execution to the next step. Used for supervised and step_by_step modes.',
      parametersSchema: {
        type: 'object',
        properties: {
          executionId: { type: 'string', description: 'Execution ID to advance' },
        },
        required: ['executionId'],
      },
      async execute(args: unknown) {
        const { executionId } = args as { executionId: string }
        const ok = executor.advance(executionId)
        if (!ok) {
          const exec = executor.getExecution(executionId)
          if (!exec) return { success: false, output: '', error: `Execution not found: ${executionId}` }
          return { success: false, output: '', error: `Execution is not awaiting approval (status: ${exec.status})` }
        }
        const exec = executor.getExecution(executionId)!
        return { success: true, output: JSON.stringify(exec) }
      },
    },
  ]
}

// ── Plugin Factory ────────────────────────────────────────────

export function createSopPlugin(mindDir?: string): DriftPlugin {
  const resolvedMindDir = mindDir || join(process.env.DRIFT_DATA_DIR || join(process.env.HOME || '/tmp', '.drift'), 'mind')
  const sopDir = join(resolvedMindDir, 'sops')
  let registry = new Map<string, Sop>()
  const executor = new SopExecutor()

  return {
    name: 'sop',
    manifest,

    async init(ctx: PluginContext) {
      // Ensure sops directory exists
      if (!existsSync(sopDir)) {
        mkdirSync(sopDir, { recursive: true })
      }

      // Load SOPs
      registry = loadSopsFromDir(sopDir, ctx.logger)
      ctx.logger.info(`SOP plugin initialized: ${registry.size} SOP(s) loaded`)

      // Publish registry — support both new (ctx.register) and old (ctx.atoms) style
      if (typeof ctx.register === 'function') {
        ctx.register('sop.registry', () => registry)
      }
      // Always set atoms for backward compat with tests and other plugins
      const atomsObj = (ctx as any).atoms
      if (atomsObj?.atom) {
        atomsObj.atom<Map<string, Sop>>('sop.registry', new Map()).reset(registry)
      }

      // Build emit shim
      const emitFn: EmitFn = (event: string, data?: unknown) => {
        if (typeof ctx.emit === 'function') {
          return ctx.emit(event, data)
        }
        return (ctx as any).events?.emit?.(event, data)
      }

      // Register tools — support both new (ctx.register) and old (ctx.registerTool) style
      const tools = buildSopTools(() => registry, executor, emitFn)
      for (const tool of tools) {
        if (typeof ctx.register === 'function') {
          ctx.register(`tool.${tool.name}`, async (data: unknown) => tool.execute(data))
        }
        if ((ctx as any).registerTool) {
          (ctx as any).registerTool(tool)
        }
      }
      ctx.logger.debug(`SOP: ${tools.length} tools registered`)
    },
  }
}

export default createSopPlugin

// ── Atom Accessor ────────────────────────────────────────────

export function getSopRegistry(ctx: PluginContext): Map<string, Sop> {
  const atomsObj = (ctx as any).atoms
  if (atomsObj?.atom) {
    return atomsObj.atom<Map<string, Sop>>('sop.registry', new Map()).deref()
  }
  return new Map()
}

// ── Re-exports ───────────────────────────────────────────────

export { parseSop, parseSopFile } from './parser.js'
export { SopExecutor } from './executor.js'
export type { StepRunnerFn } from './executor.js'
export type {
  Sop,
  SopStep,
  SopTrigger,
  SopTriggerType,
  SopExecutionMode,
  SopExecution,
  SopExecutionStatus,
  SopStepResult,
  SopStepStatus,
} from './types.js'
