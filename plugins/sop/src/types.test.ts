import { describe, it, expect } from 'vitest'
import type {
  SopTrigger,
  SopStep,
  Sop,
  SopExecution,
  SopStepResult,
  SopExecutionMode,
  SopStepStatus,
  SopExecutionStatus,
} from './types.js'

describe('SOP types (compile-time shape checks)', () => {
  it('SopTrigger accepts cron type', () => {
    const t: SopTrigger = { type: 'cron', expr: '0 8 * * 1-5' }
    expect(t.type).toBe('cron')
    expect(t.expr).toBe('0 8 * * 1-5')
  })

  it('SopTrigger accepts event type', () => {
    const t: SopTrigger = { type: 'event', event: 'chat.complete' }
    expect(t.type).toBe('event')
    expect(t.event).toBe('chat.complete')
  })

  it('SopTrigger accepts webhook type', () => {
    const t: SopTrigger = { type: 'webhook' }
    expect(t.type).toBe('webhook')
  })

  it('SopTrigger accepts manual type', () => {
    const t: SopTrigger = { type: 'manual' }
    expect(t.type).toBe('manual')
  })

  it('SopStep has required fields', () => {
    const step: SopStep = {
      number: 1,
      title: '检查日历',
      body: '查看今日日程安排',
    }
    expect(step.number).toBe(1)
    expect(step.title).toBe('检查日历')
    expect(step.body).toBe('查看今日日程安排')
    expect(step.requiresConfirmation).toBeUndefined()
    expect(step.suggestedTools).toBeUndefined()
  })

  it('SopStep accepts optional fields', () => {
    const step: SopStep = {
      number: 2,
      title: '发送报告',
      body: '生成并发送日报',
      requiresConfirmation: true,
      suggestedTools: ['mind_write', 'notify'],
    }
    expect(step.requiresConfirmation).toBe(true)
    expect(step.suggestedTools).toEqual(['mind_write', 'notify'])
  })

  it('Sop has all required fields', () => {
    const sop: Sop = {
      slug: 'morning-check',
      name: '早间检查',
      triggers: [{ type: 'cron', expr: '0 8 * * 1-5' }],
      executionMode: 'supervised',
      cooldownSecs: 3600,
      steps: [
        { number: 1, title: '检查日历', body: '查看今日日程' },
        { number: 2, title: '检查股票', body: '获取行情' },
      ],
      filePath: '/home/.drift/mind/sops/morning-check.md',
      enabled: true,
    }
    expect(sop.slug).toBe('morning-check')
    expect(sop.steps.length).toBe(2)
    expect(sop.executionMode).toBe('supervised')
    expect(sop.cooldownSecs).toBe(3600)
  })

  it('executionMode values are valid', () => {
    const modes: SopExecutionMode[] = ['auto', 'supervised', 'step_by_step']
    expect(modes.length).toBe(3)
  })

  it('SopStepStatus values are valid', () => {
    const statuses: SopStepStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped']
    expect(statuses.length).toBe(5)
  })

  it('SopExecutionStatus values are valid', () => {
    const statuses: SopExecutionStatus[] = ['pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled']
    expect(statuses.length).toBe(6)
  })

  it('SopExecution tracks step state', () => {
    const now = new Date().toISOString()
    const exec: SopExecution = {
      id: 'exec-001',
      sopSlug: 'morning-check',
      status: 'running',
      currentStep: 1,
      stepResults: [],
      startedAt: now,
    }
    expect(exec.id).toBe('exec-001')
    expect(exec.sopSlug).toBe('morning-check')
    expect(exec.status).toBe('running')
    expect(exec.currentStep).toBe(1)
    expect(exec.stepResults).toEqual([])
  })

  it('SopStepResult records output and error', () => {
    const r: SopStepResult = {
      stepNumber: 1,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      output: 'Step output text',
    }
    expect(r.stepNumber).toBe(1)
    expect(r.status).toBe('completed')
    expect(r.output).toBe('Step output text')
  })

  it('SopStepResult records failure with error', () => {
    const r: SopStepResult = {
      stepNumber: 2,
      status: 'failed',
      startedAt: new Date().toISOString(),
      error: 'Tool call failed: timeout',
    }
    expect(r.status).toBe('failed')
    expect(r.error).toBe('Tool call failed: timeout')
    expect(r.output).toBeUndefined()
  })
})
