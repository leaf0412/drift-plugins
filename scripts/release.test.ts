import { describe, it, expect } from 'vitest'

// ── Inline copies of pure functions (avoid importing script with side effects) ──

type BumpKind = 'patch' | 'minor' | 'major'

function bumpVersion(version: string, kind: BumpKind): string {
  const [major, minor, patch] = version.split('.').map(Number)
  switch (kind) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
  }
}

function calculateGlobalVersion(
  currentVersion: string,
  bumps: Map<string, BumpKind>,
): string {
  if (bumps.size === 0) return currentVersion

  const kinds = [...bumps.values()]
  const hasMajor = kinds.includes('major')
  const hasMinor = kinds.includes('minor')
  const multiplePlugins = bumps.size > 1

  if (hasMajor) {
    return bumpVersion(currentVersion, 'major')
  }
  if (multiplePlugins || hasMinor) {
    return bumpVersion(currentVersion, 'minor')
  }
  return bumpVersion(currentVersion, 'patch')
}

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── Tests ──

describe('bumpVersion', () => {
  it('bumps patch', () => {
    expect(bumpVersion('1.1.0', 'patch')).toBe('1.1.1')
    expect(bumpVersion('1.0.9', 'patch')).toBe('1.0.10')
  })

  it('bumps minor and resets patch', () => {
    expect(bumpVersion('1.1.0', 'minor')).toBe('1.2.0')
    expect(bumpVersion('1.1.5', 'minor')).toBe('1.2.0')
  })

  it('bumps major and resets minor+patch', () => {
    expect(bumpVersion('1.1.0', 'major')).toBe('2.0.0')
    expect(bumpVersion('1.3.7', 'major')).toBe('2.0.0')
  })
})

describe('calculateGlobalVersion', () => {
  it('returns current version when no bumps', () => {
    expect(calculateGlobalVersion('1.1.0', new Map())).toBe('1.1.0')
  })

  it('single plugin patch → global patch', () => {
    const bumps = new Map([['memory', 'patch' as BumpKind]])
    expect(calculateGlobalVersion('1.1.0', bumps)).toBe('1.1.1')
  })

  it('single plugin minor → global minor', () => {
    const bumps = new Map([['memory', 'minor' as BumpKind]])
    expect(calculateGlobalVersion('1.1.0', bumps)).toBe('1.2.0')
  })

  it('single plugin major → global major', () => {
    const bumps = new Map([['memory', 'major' as BumpKind]])
    expect(calculateGlobalVersion('1.1.0', bumps)).toBe('2.0.0')
  })

  it('multiple plugins with patches → global minor', () => {
    const bumps = new Map<string, BumpKind>([
      ['memory', 'patch'],
      ['feed', 'patch'],
    ])
    expect(calculateGlobalVersion('1.1.0', bumps)).toBe('1.2.0')
  })

  it('any major among multiple → global major', () => {
    const bumps = new Map<string, BumpKind>([
      ['memory', 'patch'],
      ['feed', 'major'],
    ])
    expect(calculateGlobalVersion('1.1.0', bumps)).toBe('2.0.0')
  })

  it('multiple plugins with one minor → global minor', () => {
    const bumps = new Map<string, BumpKind>([
      ['memory', 'patch'],
      ['feed', 'minor'],
    ])
    expect(calculateGlobalVersion('1.1.0', bumps)).toBe('1.2.0')
  })
})

describe('todayISO', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
