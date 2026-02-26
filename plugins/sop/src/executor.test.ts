import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SopExecutor } from './executor.js'
import type { Sop } from './types.js'
import type { StepRunnerFn } from './executor.js'

// ── Test helpers ──────────────────────────────────────────────

function makeSop(overrides: Partial<Sop> = {}): Sop {
  return {
    slug: 'test-sop',
    name: 'Test SOP',
    triggers: [],
    executionMode: 'auto',
    cooldownSecs: 0,
    steps: [
      { number: 1, title: 'Step One', body: 'Do step one' },
      { number: 2, title: 'Step Two', body: 'Do step two' },
      { number: 3, title: 'Step Three', body: 'Do step three' },
    ],
    filePath: '/path/test-sop.md',
    enabled: true,
    ...overrides,
  }
}

function makeSuccessRunner(): StepRunnerFn {
  return vi.fn().mockImplementation(async (step) => ({
    output: `Completed: ${step.title}`,
    error: undefined,
  }))
}

function makeFailRunner(failOnStep: number): StepRunnerFn {
  return vi.fn().mockImplementation(async (step) => {
    if (step.number === failOnStep) {
      return { output: undefined, error: `Step ${step.number} failed` }
    }
    return { output: `Done: ${step.title}`, error: undefined }
  })
}

// ── SopExecutor Tests ─────────────────────────────────────────

describe('SopExecutor', () => {
  let executor: SopExecutor

  beforeEach(() => {
    executor = new SopExecutor()
  })

  // ── start ─────────────────────────────────────────────────

  describe('start()', () => {
    it('creates execution with pending status and unique id', () => {
      const sop = makeSop()
      const exec = executor.start(sop)
      expect(exec.sopSlug).toBe('test-sop')
      expect(exec.status).toBe('pending')
      expect(exec.currentStep).toBe(1)
      expect(exec.stepResults).toEqual([])
      expect(exec.id).toBeTruthy()
      expect(exec.startedAt).toBeTruthy()
    })

    it('generates unique ids for each execution', () => {
      const sop = makeSop()
      const a = executor.start(sop)
      const b = executor.start(sop)
      expect(a.id).not.toBe(b.id)
    })

    it('stores execution and retrieves via getExecution', () => {
      const sop = makeSop()
      const exec = executor.start(sop)
      const retrieved = executor.getExecution(exec.id)
      expect(retrieved).toBeDefined()
      expect(retrieved!.id).toBe(exec.id)
    })
  })

  // ── run (auto mode) ───────────────────────────────────────

  describe('run() — auto mode', () => {
    it('runs all steps sequentially and completes', async () => {
      const sop = makeSop({ executionMode: 'auto' })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      expect(result.status).toBe('completed')
      expect(result.stepResults.length).toBe(3)
      expect(result.stepResults.every(r => r.status === 'completed')).toBe(true)
      expect(runner).toHaveBeenCalledTimes(3)
    })

    it('stops at failing step and marks execution failed', async () => {
      const sop = makeSop({ executionMode: 'auto' })
      const runner = makeFailRunner(2)
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      expect(result.status).toBe('failed')
      expect(result.stepResults.length).toBe(2)
      expect(result.stepResults[0].status).toBe('completed')
      expect(result.stepResults[1].status).toBe('failed')
      expect(result.stepResults[1].error).toBe('Step 2 failed')
      expect(result.failureReason).toContain('Step 2')
    })

    it('records step output in stepResults', async () => {
      const sop = makeSop({ executionMode: 'auto' })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      expect(result.stepResults[0].output).toBe('Completed: Step One')
      expect(result.stepResults[1].output).toBe('Completed: Step Two')
    })

    it('records startedAt and completedAt for each step', async () => {
      const sop = makeSop({ executionMode: 'auto' })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      for (const sr of result.stepResults) {
        expect(sr.startedAt).toBeTruthy()
        expect(sr.completedAt).toBeTruthy()
      }
    })

    it('records completedAt on successful run', async () => {
      const sop = makeSop({ executionMode: 'auto' })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      expect(result.completedAt).toBeTruthy()
    })
  })

  // ── run (supervised mode) ─────────────────────────────────

  describe('run() — supervised mode', () => {
    it('pauses on steps with requiresConfirmation', async () => {
      const sop = makeSop({
        executionMode: 'supervised',
        steps: [
          { number: 1, title: 'Auto Step', body: 'No confirm' },
          { number: 2, title: 'Confirm Step', body: 'Needs confirm', requiresConfirmation: true },
          { number: 3, title: 'Final Step', body: 'After confirm' },
        ],
      })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      // Should pause at step 2
      expect(result.status).toBe('awaiting_approval')
      expect(result.currentStep).toBe(2)
      expect(result.stepResults.length).toBe(1) // only step 1 ran
      expect(runner).toHaveBeenCalledTimes(1)
    })

    it('continues after advance() is called', async () => {
      const sop = makeSop({
        executionMode: 'supervised',
        steps: [
          { number: 1, title: 'Auto Step', body: 'No confirm' },
          { number: 2, title: 'Confirm Step', body: 'Needs confirm', requiresConfirmation: true },
          { number: 3, title: 'Final Step', body: 'After confirm' },
        ],
      })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      // Run until pause
      const paused = await executor.run(exec.id, sop, runner)
      expect(paused.status).toBe('awaiting_approval')

      // Advance past the confirmation step
      executor.advance(exec.id)

      // Continue
      const finished = await executor.run(exec.id, sop, runner)
      expect(finished.status).toBe('completed')
      expect(finished.stepResults.length).toBe(3)
    })
  })

  // ── run (step_by_step mode) ───────────────────────────────

  describe('run() — step_by_step mode', () => {
    it('pauses after every step', async () => {
      const sop = makeSop({ executionMode: 'step_by_step' })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      const result = await executor.run(exec.id, sop, runner)

      expect(result.status).toBe('awaiting_approval')
      expect(result.stepResults.length).toBe(1)
      expect(runner).toHaveBeenCalledTimes(1)
    })

    it('completes all steps with repeated advance + run', async () => {
      const sop = makeSop({ executionMode: 'step_by_step' })
      const runner = makeSuccessRunner()
      const exec = executor.start(sop)

      await executor.run(exec.id, sop, runner) // step 1
      executor.advance(exec.id)
      await executor.run(exec.id, sop, runner) // step 2
      executor.advance(exec.id)
      const final = await executor.run(exec.id, sop, runner) // step 3

      expect(final.status).toBe('completed')
      expect(runner).toHaveBeenCalledTimes(3)
    })
  })

  // ── cancel ────────────────────────────────────────────────

  describe('cancel()', () => {
    it('marks running execution as cancelled', async () => {
      const sop = makeSop()
      const exec = executor.start(sop)
      executor.cancel(exec.id)
      const updated = executor.getExecution(exec.id)
      expect(updated!.status).toBe('cancelled')
    })

    it('returns false for unknown execution id', () => {
      const result = executor.cancel('nonexistent')
      expect(result).toBe(false)
    })

    it('returns true when cancelled successfully', () => {
      const sop = makeSop()
      const exec = executor.start(sop)
      const result = executor.cancel(exec.id)
      expect(result).toBe(true)
    })
  })

  // ── advance ───────────────────────────────────────────────

  describe('advance()', () => {
    it('returns false for unknown execution id', () => {
      expect(executor.advance('nonexistent')).toBe(false)
    })

    it('returns false when execution is not awaiting_approval', () => {
      const sop = makeSop()
      const exec = executor.start(sop)
      // Still pending, not awaiting_approval
      expect(executor.advance(exec.id)).toBe(false)
    })
  })

  // ── listExecutions ────────────────────────────────────────

  describe('listExecutions()', () => {
    it('returns all active executions', () => {
      const sop = makeSop()
      executor.start(sop)
      executor.start(sop)
      const list = executor.listExecutions()
      expect(list.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by sopSlug', () => {
      const sop1 = makeSop({ slug: 'sop-a' })
      const sop2 = makeSop({ slug: 'sop-b' })
      executor.start(sop1)
      executor.start(sop2)
      const filtered = executor.listExecutions('sop-a')
      expect(filtered.every(e => e.sopSlug === 'sop-a')).toBe(true)
    })
  })
})
