// sop/index.ts — SOP plugin factory
import type { DriftPlugin, DriftTool, ToolResult, PluginContext } from '@drift/core/kernel'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSopFile } from './parser.js'
import { SopExecutor } from './executor.js'
import type { Sop } from './types.js'

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

function buildSopTools(
  getRegistry: () => Map<string, Sop>,
  getExecutor: () => SopExecutor,
): DriftTool[] {
  return [
    // sop_list — list all available SOPs
    {
      name: 'sop_list',
      description: 'List all available SOPs (Standard Operating Procedures) loaded from the mind/sops directory.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      async execute(_args: unknown, _ctx: PluginContext): Promise<ToolResult> {
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
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'SOP slug (filename without .md extension)' },
        },
        required: ['slug'],
      },
      async execute(args: unknown, ctx: PluginContext): Promise<ToolResult> {
        const { slug } = args as { slug: string }
        const registry = getRegistry()
        const executor = getExecutor()
        const sop = registry.get(slug)
        if (!sop) {
          return { success: false, output: '', error: `SOP not found: ${slug}` }
        }

        const exec = executor.start(sop)
        ctx.emit('sop.started', { sopSlug: sop.slug, executionId: exec.id })

        // No-op step runner — in real usage this would be injected by the agent plugin
        // The executor state machine advances; actual LLM execution is done externally
        const noopRunner = async () => ({ output: '(queued for execution)' })
        const result = await executor.run(exec.id, sop, noopRunner)

        if (result.status === 'completed') {
          ctx.emit('sop.completed', { sopSlug: sop.slug, executionId: exec.id })
        } else if (result.status === 'failed') {
          ctx.emit('sop.failed', { sopSlug: sop.slug, executionId: exec.id, reason: result.failureReason })
        } else if (result.status === 'awaiting_approval') {
          ctx.emit('sop.paused', { sopSlug: sop.slug, executionId: exec.id, currentStep: result.currentStep })
        }

        return { success: true, output: JSON.stringify(result) }
      },
    },

    // sop_status — get status of an execution
    {
      name: 'sop_status',
      description: 'Get the current status of a SOP execution by its execution ID.',
      parameters: {
        type: 'object',
        properties: {
          executionId: { type: 'string', description: 'Execution ID returned by sop_run' },
        },
        required: ['executionId'],
      },
      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const { executionId } = args as { executionId: string }
        const executor = getExecutor()
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
      parameters: {
        type: 'object',
        properties: {
          executionId: { type: 'string', description: 'Execution ID to advance' },
        },
        required: ['executionId'],
      },
      async execute(args: unknown, _ctx: PluginContext): Promise<ToolResult> {
        const { executionId } = args as { executionId: string }
        const executor = getExecutor()
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
    version: '1.1.0',
    tools: buildSopTools(() => registry, () => executor),
    capabilities: {
      'sop.registry': () => registry,
    },

    async init(ctx: PluginContext) {
      // Ensure sops directory exists
      if (!existsSync(sopDir)) {
        mkdirSync(sopDir, { recursive: true })
      }

      // Load SOPs
      registry = loadSopsFromDir(sopDir, ctx.logger)
      ctx.logger.info(`SOP plugin initialized: ${registry.size} SOP(s) loaded`)

      ctx.logger.debug(`SOP: ${buildSopTools(() => registry, () => executor).length} tools declared`)
    },
  }
}

export default createSopPlugin

// ── Service Accessor ─────────────────────────────────────────

export async function getSopRegistry(ctx: PluginContext): Promise<Map<string, Sop>> {
  return ctx.call<Map<string, Sop>>('sop.registry')
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
