import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { AtomRegistry } from '@drift/core'
import { createSopPlugin } from './index.js'
import type { PluginContext, LoggerLike } from '@drift/core'

// ── Test helpers ──────────────────────────────────────────────

function makeLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function makeAtoms() {
  return new AtomRegistry()
}

function makeEventBus() {
  return {
    on: vi.fn(() => () => {}),
    emit: vi.fn(async () => {}),
    off: vi.fn(),
    clear: vi.fn(),
  }
}

interface ToolRegistration {
  name: string
  execute: (args: unknown) => Promise<{ success: boolean; output: string; error?: string }>
}

function makeContext(atoms: AtomRegistry, logger: LoggerLike): PluginContext & { registerTool: ReturnType<typeof vi.fn> } {
  const registeredTools: string[] = []
  const ctx = {
    tools: { register: vi.fn(), unregister: vi.fn(), list: vi.fn(() => []) },
    events: makeEventBus(),
    routes: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
    storage: { queryAll: vi.fn(() => []), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
    atoms,
    config: { get: vi.fn(), set: vi.fn() },
    logger,
    chat: vi.fn() as any,
    channels: { register: vi.fn(), unregister: vi.fn(), get: vi.fn(), list: vi.fn(() => []), broadcast: vi.fn() },
    registerTool: vi.fn((reg: ToolRegistration) => { registeredTools.push(reg.name) }),
  }
  return ctx as unknown as PluginContext & { registerTool: ReturnType<typeof vi.fn> }
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

  it('has correct manifest', () => {
    const plugin = createSopPlugin(mindDir)
    expect(plugin.manifest.name).toBe('sop')
    expect(plugin.manifest.type).toBe('code')
    expect(plugin.manifest.capabilities.tools).toContain('sop_list')
    expect(plugin.manifest.capabilities.tools).toContain('sop_run')
    expect(plugin.manifest.capabilities.tools).toContain('sop_status')
    expect(plugin.manifest.capabilities.tools).toContain('sop_advance')
  })

  it('initializes without error when sops dir is empty', async () => {
    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const plugin = createSopPlugin(mindDir)
    await expect(plugin.init(ctx)).resolves.not.toThrow()
  })

  it('creates sops directory if it does not exist', async () => {
    const newMindDir = join(tmpDir, 'fresh-mind')
    mkdirSync(newMindDir, { recursive: true })
    // sops dir does NOT exist yet

    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const plugin = createSopPlugin(newMindDir)

    await plugin.init(ctx)

    const { existsSync } = await import('node:fs')
    expect(existsSync(join(newMindDir, 'sops'))).toBe(true)
  })

  it('loads SOP files on init and exposes via sop.registry atom', async () => {
    writeSopMd(sopDir, 'morning-check.md', SIMPLE_SOP)

    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const plugin = createSopPlugin(mindDir)
    await plugin.init(ctx)

    const registry = atoms.atom<Map<string, unknown>>('sop.registry', new Map()).deref()
    expect(registry.size).toBe(1)
    expect(registry.has('morning-check')).toBe(true)
  })

  it('registers sop_list, sop_run, sop_status, sop_advance tools via registerTool', async () => {
    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const registeredNames: string[] = []
    ctx.registerTool = vi.fn((reg: ToolRegistration) => { registeredNames.push(reg.name) })

    const plugin = createSopPlugin(mindDir)
    await plugin.init(ctx)

    expect(registeredNames).toContain('sop_list')
    expect(registeredNames).toContain('sop_run')
    expect(registeredNames).toContain('sop_status')
    expect(registeredNames).toContain('sop_advance')
  })

  it('sop_list tool returns list of SOP slugs', async () => {
    writeSopMd(sopDir, 'sop-a.md', SIMPLE_SOP)
    writeSopMd(sopDir, 'sop-b.md', SIMPLE_SOP)

    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const tools: Map<string, (args: unknown) => Promise<{ success: boolean; output: string }>> = new Map()
    ctx.registerTool = vi.fn((reg: ToolRegistration) => { tools.set(reg.name, reg.execute as any) })

    const plugin = createSopPlugin(mindDir)
    await plugin.init(ctx)

    const listFn = tools.get('sop_list')!
    const result = await listFn({})
    expect(result.success).toBe(true)
    const parsed = JSON.parse(result.output)
    expect(parsed.map((s: { slug: string }) => s.slug).sort()).toEqual(['sop-a', 'sop-b'])
  })

  it('sop_status tool returns 404-style error for unknown execution', async () => {
    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const tools: Map<string, (args: unknown) => Promise<{ success: boolean; output: string; error?: string }>> = new Map()
    ctx.registerTool = vi.fn((reg: ToolRegistration) => { tools.set(reg.name, reg.execute as any) })

    const plugin = createSopPlugin(mindDir)
    await plugin.init(ctx)

    const statusFn = tools.get('sop_status')!
    const result = await statusFn({ executionId: 'nonexistent' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('sop_run tool returns error for unknown sop slug', async () => {
    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const tools: Map<string, (args: unknown) => Promise<{ success: boolean; output: string; error?: string }>> = new Map()
    ctx.registerTool = vi.fn((reg: ToolRegistration) => { tools.set(reg.name, reg.execute as any) })

    const plugin = createSopPlugin(mindDir)
    await plugin.init(ctx)

    const runFn = tools.get('sop_run')!
    const result = await runFn({ slug: 'nonexistent' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('emits sop.started event when sop_run is called', async () => {
    writeSopMd(sopDir, 'test-sop.md', SIMPLE_SOP)

    const atoms = makeAtoms()
    const logger = makeLogger()
    const ctx = makeContext(atoms, logger)
    const tools: Map<string, (args: unknown) => Promise<{ success: boolean; output: string }>> = new Map()
    ctx.registerTool = vi.fn((reg: ToolRegistration) => { tools.set(reg.name, reg.execute as any) })

    const plugin = createSopPlugin(mindDir)
    await plugin.init(ctx)

    const runFn = tools.get('sop_run')!
    await runFn({ slug: 'test-sop' })

    expect((ctx.events.emit as ReturnType<typeof vi.fn>).mock.calls.some(
      (call: unknown[]) => call[0] === 'sop.started'
    )).toBe(true)
  })
})
