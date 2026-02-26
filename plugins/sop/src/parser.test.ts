import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseSop, parseSopFile } from './parser.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const MINIMAL_SOP = `---
name: 最简 SOP
---

## Step 1: 做某事
执行此步骤的内容。
`

const FULL_SOP = `---
name: 早间检查
triggers:
  - type: cron
    expr: "0 8 * * 1-5"
  - type: manual
execution: supervised
cooldown: 3600
enabled: true
---

## Step 1: 检查日历
查看今日日程安排

## Step 2: 检查股票
获取自选股行情，工具提示：mind_read

## Step 3: 生成日报
综合以上信息，生成今日摘要
需要确认: true
`

const DISABLED_SOP = `---
name: 已禁用流程
enabled: false
---

## Step 1: 某步骤
一些内容
`

describe('parseSop', () => {
  it('parses minimal SOP with only name and one step', () => {
    const sop = parseSop(MINIMAL_SOP, 'minimal', '/path/minimal.md')
    expect(sop.slug).toBe('minimal')
    expect(sop.name).toBe('最简 SOP')
    expect(sop.enabled).toBe(true)
    expect(sop.executionMode).toBe('auto')
    expect(sop.cooldownSecs).toBe(0)
    expect(sop.triggers).toEqual([])
    expect(sop.steps.length).toBe(1)
    expect(sop.steps[0].number).toBe(1)
    expect(sop.steps[0].title).toBe('做某事')
    expect(sop.steps[0].body.trim()).toBe('执行此步骤的内容。')
    expect(sop.filePath).toBe('/path/minimal.md')
  })

  it('parses full SOP with triggers, mode, cooldown, and multiple steps', () => {
    const sop = parseSop(FULL_SOP, 'morning-check', '/path/morning-check.md')
    expect(sop.name).toBe('早间检查')
    expect(sop.executionMode).toBe('supervised')
    expect(sop.cooldownSecs).toBe(3600)
    expect(sop.enabled).toBe(true)
    expect(sop.triggers.length).toBe(2)
    expect(sop.triggers[0]).toEqual({ type: 'cron', expr: '0 8 * * 1-5' })
    expect(sop.triggers[1]).toEqual({ type: 'manual' })
    expect(sop.steps.length).toBe(3)
  })

  it('parses step numbers and titles correctly', () => {
    const sop = parseSop(FULL_SOP, 'morning-check', '/path/morning-check.md')
    expect(sop.steps[0].number).toBe(1)
    expect(sop.steps[0].title).toBe('检查日历')
    expect(sop.steps[1].number).toBe(2)
    expect(sop.steps[1].title).toBe('检查股票')
    expect(sop.steps[2].number).toBe(3)
    expect(sop.steps[2].title).toBe('生成日报')
  })

  it('parses step body content', () => {
    const sop = parseSop(FULL_SOP, 'morning-check', '/path/morning-check.md')
    expect(sop.steps[0].body.trim()).toBe('查看今日日程安排')
    expect(sop.steps[1].body).toContain('获取自选股行情')
  })

  it('defaults executionMode to auto when not set', () => {
    const sop = parseSop(MINIMAL_SOP, 'minimal', '/path/minimal.md')
    expect(sop.executionMode).toBe('auto')
  })

  it('maps execution field aliases (supervised → supervised)', () => {
    const raw = `---\nname: test\nexecution: step_by_step\n---\n\n## Step 1: X\nBody`
    const sop = parseSop(raw, 'test', '/path/test.md')
    expect(sop.executionMode).toBe('step_by_step')
  })

  it('handles enabled: false', () => {
    const sop = parseSop(DISABLED_SOP, 'disabled', '/path/disabled.md')
    expect(sop.enabled).toBe(false)
  })

  it('returns empty steps when no Step headings exist', () => {
    const raw = `---\nname: No Steps\n---\n\nJust some prose without step headings.`
    const sop = parseSop(raw, 'empty', '/path/empty.md')
    expect(sop.steps).toEqual([])
  })

  it('handles steps with non-sequential numbers', () => {
    const raw = `---\nname: Skip\n---\n\n## Step 1: First\nBody A\n\n## Step 3: Third\nBody C`
    const sop = parseSop(raw, 'skip', '/path/skip.md')
    expect(sop.steps.length).toBe(2)
    expect(sop.steps[0].number).toBe(1)
    expect(sop.steps[1].number).toBe(3)
  })

  it('defaults cooldown to 0 when not set', () => {
    const sop = parseSop(MINIMAL_SOP, 'minimal', '/path/minimal.md')
    expect(sop.cooldownSecs).toBe(0)
  })

  it('preserves filePath as provided', () => {
    const sop = parseSop(MINIMAL_SOP, 'slug', '/absolute/path/sop.md')
    expect(sop.filePath).toBe('/absolute/path/sop.md')
  })
})

describe('parseSopFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drift-sop-parser-'))
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('reads and parses a real file', () => {
    const filePath = join(tmpDir, 'morning-check.md')
    writeFileSync(filePath, MINIMAL_SOP, 'utf-8')
    const sop = parseSopFile(filePath)
    expect(sop.slug).toBe('morning-check')
    expect(sop.name).toBe('最简 SOP')
    expect(sop.filePath).toBe(filePath)
  })

  it('derives slug from filename without extension', () => {
    const filePath = join(tmpDir, 'weekly-report.md')
    writeFileSync(filePath, MINIMAL_SOP, 'utf-8')
    const sop = parseSopFile(filePath)
    expect(sop.slug).toBe('weekly-report')
  })

  it('throws on non-existent file', () => {
    expect(() => parseSopFile(join(tmpDir, 'nonexistent.md'))).toThrow()
  })
})
