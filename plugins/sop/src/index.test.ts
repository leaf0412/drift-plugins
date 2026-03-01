import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createSopPlugin } from './index.js'
import type { PluginContext, LoggerLike } from '@drift/core/kernel'

// ── Test helpers ──────────────────────────────────────────────

function makeLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

interface ToolRegistration {
  name: string
  execute: (args: unknown) => Promise<{ success: boolean; output: string; error?: string }>
}

function makeContext(logger: LoggerLike): PluginContext {
  const registeredServices = new Map<string, Function>()
  const ctx = {
    pluginId: 'sop',
    logger,
    register: vi.fn((key: string, handler: Function) => { registeredServices.set(key, handler) }),
    call: vi.fn(async (key: string, ...args: unknown[]) => {
      const handler = registeredServices.get(key)
      if (handler) return handler(...args)
      throw new Error(`Service not found: ${key}`)
    }),
    emit: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  }
  return ctx as unknown as PluginContext
}

function writeSopMd(sopDir: string, filename: string, content: string): void {
  writeFileSync(join(sopDir, filename), content, 'utf-8')
}

const SIMPLE_SOP = `---
name: 简单流程
---

## Step 1: 第一步
做点什么

## Step 2: 第二步
再做点什么
`

// ── Tests ─────────────────────────────────────────────────────

describe('createSopPlugin', () => {
  let tmpDir: string
  let mindDir: string
  let sopDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drift-sop-plugin-'))
    mindDir = join(tmpDir, 'mind')
    sopDir = join(mindDir, 'sops')
    mkdirSync(sopDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('has correct name', () => {
    const plugin = createSopPlugin(mindDir)
    expect(plugin.name).toBe('sop')
  })

  it('initializes without error when sops dir is empty', async () => {
    const logger = makeLogger()
    const ctx = makeContext(logger)
    const plugin = createSopPlugin(mindDir)
    await expect(plugin.init!(ctx)).resolves.not.toThrow()
  })

  it('creates sops directory if it does not exist', async () => {
    const newMindDir = join(tmpDir, 'fresh-mind')
    mkdirSync(newMindDir, { recursive: true })
    // sops dir does NOT exist yet

    const logger = makeLogger()
    const ctx = makeContext(logger)
    const plugin = createSopPlugin(newMindDir)

    await plugin.init!(ctx)

    const { existsSync } = await import('node:fs')
    expect(existsSync(join(newMindDir, 'sops'))).toBe(true)
  })

  it('loads SOP files on init and exposes via ctx.register', async () => {
    writeSopMd(sopDir, 'morning-check.md', SIMPLE_SOP)

    const logger = makeLogger()
    const ctx = makeContext(logger)
    const plugin = createSopPlugin(mindDir)
    await plugin.init!(ctx)

    // sop.registry is registered via ctx.register, retrieve via ctx.call
    const registry = await ctx.call<Map<string, unknown>>('sop.registry')
    expect(registry.size).toBe(1)
    expect(registry.has('morning-check')).toBe(true)
  })

  it('registers sop_list, sop_run, sop_status, sop_advance tools via ctx.register', async () => {
    const logger = makeLogger()
    const ctx = makeContext(logger)

    const plugin = createSopPlugin(mindDir)
    await plugin.init!(ctx)

    const registerCalls = (ctx.register as ReturnType<typeof vi.fn>).mock.calls
    const registeredKeys = registerCalls.map((call: unknown[]) => call[0] as string)
    expect(registeredKeys).toContain('tool.sop_list')
    expect(registeredKeys).toContain('tool.sop_run')
    expect(registeredKeys).toContain('tool.sop_status')
    expect(registeredKeys).toContain('tool.sop_advance')
  })

  it('sop_list tool returns list of SOP slugs', async () => {
    writeSopMd(sopDir, 'sop-a.md', SIMPLE_SOP)
    writeSopMd(sopDir, 'sop-b.md', SIMPLE_SOP)

    const logger = makeLogger()
    const ctx = makeContext(logger)

    const plugin = createSopPlugin(mindDir)
    await plugin.init!(ctx)

    const result = await ctx.call<{ success: boolean; output: string }>('tool.sop_list', {})
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.map((s: { slug: string }) => s.slug).sort()).toEqual(['sop-a', 'sop-b'])
  })

  it('sop_status tool returns 404-style error for unknown execution', async () => {
    const logger = makeLogger()
    const ctx = makeContext(logger)

    const plugin = createSopPlugin(mindDir)
    await plugin.init!(ctx)

    const result = await ctx.call<{ success: boolean; output: string; error?: string }>('tool.sop_status', { executionId: 'nonexistent' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('sop_run tool returns error for unknown sop slug', async () => {
    const logger = makeLogger()
    const ctx = makeContext(logger)

    const plugin = createSopPlugin(mindDir)
    await plugin.init!(ctx)

    const result = await ctx.call<{ success: boolean; output: string; error?: string }>('tool.sop_run', { slug: 'nonexistent' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('emits sop.started event when sop_run is called', async () => {
    writeSopMd(sopDir, 'test-sop.md', SIMPLE_SOP)

    const logger = makeLogger()
    const ctx = makeContext(logger)

    const plugin = createSopPlugin(mindDir)
    await plugin.init!(ctx)

    await ctx.call('tool.sop_run', { slug: 'test-sop' })

    expect((ctx.emit as ReturnType<typeof vi.fn>).mock.calls.some(
      (call: unknown[]) => call[0] === 'sop.started'
    )).toBe(true)
  })
})
