import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import matter from 'gray-matter'
import { ensureMemoryDigestAgent } from './digest-agent.js'

// ── Helpers ─────────────────────────────────────────────────

let tmpDirs: string[] = []

function makeTmpMindDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-digest-agent-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tmpDirs = []
})

// ── Tests ───────────────────────────────────────────────────

describe('ensureMemoryDigestAgent', () => {
  it('creates agent.md in correct path', () => {
    const mindDir = makeTmpMindDir()

    ensureMemoryDigestAgent(mindDir)

    const agentMdPath = join(mindDir, 'agents', 'memory-digest', 'agent.md')
    expect(existsSync(agentMdPath)).toBe(true)
  })

  it('creates agents/ directory if it does not exist', () => {
    const mindDir = makeTmpMindDir()

    ensureMemoryDigestAgent(mindDir)

    expect(existsSync(join(mindDir, 'agents'))).toBe(true)
    expect(existsSync(join(mindDir, 'agents', 'memory-digest'))).toBe(true)
  })

  it('has correct YAML frontmatter fields', () => {
    const mindDir = makeTmpMindDir()

    ensureMemoryDigestAgent(mindDir)

    const agentMdPath = join(mindDir, 'agents', 'memory-digest', 'agent.md')
    const raw = readFileSync(agentMdPath, 'utf-8')
    const { data, content } = matter(raw)

    // Required frontmatter fields
    expect(data.name).toBe('Memory Digest')
    expect(data.trigger).toEqual({ type: 'cron', expr: '0 0 * * *' })
    expect(data.autonomy).toBe('full')
    expect(data.output).toEqual({ notify: false, journal: true })
    expect(data.permissions?.allowed_tools).toEqual(
      expect.arrayContaining(['memory_save', 'memory_list', 'mind_read', 'mind_write', 'mind_search'])
    )
    expect(data.session).toBe('new')
    expect(data.enabled).toBe(true)

    // Prompt body should be non-empty
    expect(content.trim().length).toBeGreaterThan(0)
  })

  it('does not overwrite existing file', () => {
    const mindDir = makeTmpMindDir()
    const agentDir = join(mindDir, 'agents', 'memory-digest')
    mkdirSync(agentDir, { recursive: true })

    const customContent = '---\nname: Custom Agent\n---\nMy custom prompt'
    const agentMdPath = join(agentDir, 'agent.md')
    writeFileSync(agentMdPath, customContent, 'utf-8')

    ensureMemoryDigestAgent(mindDir)

    const afterContent = readFileSync(agentMdPath, 'utf-8')
    expect(afterContent).toBe(customContent)
  })

  it('is idempotent when called multiple times', () => {
    const mindDir = makeTmpMindDir()

    ensureMemoryDigestAgent(mindDir)
    const firstContent = readFileSync(
      join(mindDir, 'agents', 'memory-digest', 'agent.md'),
      'utf-8',
    )

    ensureMemoryDigestAgent(mindDir)
    const secondContent = readFileSync(
      join(mindDir, 'agents', 'memory-digest', 'agent.md'),
      'utf-8',
    )

    expect(firstContent).toBe(secondContent)
  })
})
