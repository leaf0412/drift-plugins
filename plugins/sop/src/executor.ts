// sop/executor.ts — SOP execution state machine
// Does NOT call LLM directly — delegates to injected StepRunnerFn
import { randomUUID } from 'node:crypto'
import dayjs from 'dayjs'
import type { Sop, SopStep, SopExecution, SopStepResult } from './types.js'

// ── Step Runner (injected dependency) ───────────────────────

/**
 * External function that executes a single SOP step.
 * Injected so the executor does not depend on the LLM or chat system.
 * Returns the step output or an error string.
 */
export type StepRunnerFn = (step: SopStep, execution: SopExecution) => Promise<{
  output?: string
  error?: string
}>

// ── Executor ─────────────────────────────────────────────────

export class SopExecutor {
  private executions: Map<string, SopExecution> = new Map()
  /** Tracks steps that have been approved via advance() — keyed by executionId */
  private advancedSteps: Map<string, Set<number>> = new Map()

  /**
   * Create a new SopExecution in 'pending' state.
   * Call run() to begin executing.
   */
  start(sop: Sop): SopExecution {
    const exec: SopExecution = {
      id: randomUUID(),
      sopSlug: sop.slug,
      status: 'pending',
      currentStep: sop.steps[0]?.number ?? 1,
      stepResults: [],
      startedAt: dayjs().toISOString(),
    }
    this.executions.set(exec.id, exec)
    return { ...exec }
  }

  /**
   * Run the execution until it completes, fails, or needs approval.
   *
   * - 'auto': runs all steps without pausing
   * - 'supervised': pauses at steps with requiresConfirmation = true
   * - 'step_by_step': pauses after every step
   *
   * Call advance(id) to resume a paused execution, then run() again.
   */
  async run(
    executionId: string,
    sop: Sop,
    runner: StepRunnerFn,
  ): Promise<SopExecution> {
    const exec = this.executions.get(executionId)
    if (!exec) throw new Error(`Execution not found: ${executionId}`)
    if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'cancelled') {
      return { ...exec }
    }

    exec.status = 'running'

    const remainingSteps = sop.steps.filter(s => {
      // Skip already-completed or failed steps
      const done = exec.stepResults.find(r => r.stepNumber === s.number)
      return !done && s.number >= exec.currentStep
    })

    const approved = this.advancedSteps.get(executionId) ?? new Set()

    for (const step of remainingSteps) {
      // Check if we need to pause before running this step (supervised mode)
      if (sop.executionMode === 'supervised' && step.requiresConfirmation && !approved.has(step.number)) {
        exec.status = 'awaiting_approval'
        exec.currentStep = step.number
        this.executions.set(executionId, exec)
        return { ...exec }
      }

      // Execute the step
      exec.currentStep = step.number
      const stepResult: SopStepResult = {
        stepNumber: step.number,
        status: 'running',
        startedAt: dayjs().toISOString(),
      }
      exec.stepResults.push(stepResult)

      const { output, error } = await runner(step, { ...exec })

      stepResult.completedAt = dayjs().toISOString()

      if (error) {
        stepResult.status = 'failed'
        stepResult.error = error
        exec.status = 'failed'
        exec.failureReason = `Step ${step.number} (${step.title}) failed: ${error}`
        this.executions.set(executionId, exec)
        return { ...exec }
      }

      stepResult.status = 'completed'
      stepResult.output = output

      // Check if we need to pause after running this step (step_by_step mode)
      if (sop.executionMode === 'step_by_step') {
        // Advance currentStep pointer past this step
        const nextIdx = sop.steps.findIndex(s => s.number === step.number) + 1
        if (nextIdx < sop.steps.length) {
          exec.currentStep = sop.steps[nextIdx].number
          exec.status = 'awaiting_approval'
          this.executions.set(executionId, exec)
          return { ...exec }
        }
      }
    }

    // All steps done
    exec.status = 'completed'
    exec.completedAt = dayjs().toISOString()
    this.executions.set(executionId, exec)
    return { ...exec }
  }

  /**
   * Resume a paused (awaiting_approval) execution.
   * Returns false if the execution is not in awaiting_approval state.
   */
  advance(executionId: string): boolean {
    const exec = this.executions.get(executionId)
    if (!exec || exec.status !== 'awaiting_approval') return false
    // Record the current step as approved so we don't pause on it again
    let approved = this.advancedSteps.get(executionId)
    if (!approved) {
      approved = new Set()
      this.advancedSteps.set(executionId, approved)
    }
    approved.add(exec.currentStep)
    exec.status = 'running'
    this.executions.set(executionId, exec)
    return true
  }

  /**
   * Cancel an active execution.
   * Returns false if the execution does not exist.
   */
  cancel(executionId: string): boolean {
    const exec = this.executions.get(executionId)
    if (!exec) return false
    exec.status = 'cancelled'
    exec.completedAt = dayjs().toISOString()
    this.executions.set(executionId, exec)
    return true
  }

  getExecution(executionId: string): SopExecution | undefined {
    const exec = this.executions.get(executionId)
    return exec ? { ...exec } : undefined
  }

  listExecutions(sopSlug?: string): SopExecution[] {
    const all = [...this.executions.values()].map(e => ({ ...e }))
    return sopSlug ? all.filter(e => e.sopSlug === sopSlug) : all
  }
}
