/**
 * Release script for drift-plugins monorepo.
 *
 * Detects changed plugins since the last git tag, prompts for version bumps,
 * updates version strings, generates a CHANGELOG entry, and commits + tags.
 *
 * Usage:
 *   pnpm release            # interactive release
 *   pnpm release --dry-run  # preview only, no writes
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

// ── Constants ──────────────────────────────────────────────

const PLUGINS = [
  'channel',
  'cli-channel',
  'coding',
  'feed',
  'feishu',
  'memory',
  'notify',
  'plugin-mgr',
  'session-api',
  'sop',
  'system-status',
  'task',
  'telegram',
  'web-channel',
] as const

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()

const TS_VERSION_RE = /version:\s*'(\d+\.\d+\.\d+)'/
const JSON_VERSION_RE = /"version":\s*"(\d+\.\d+\.\d+)"/

type BumpKind = 'patch' | 'minor' | 'major'

// ── CLI args ───────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run')

// ── Helpers ────────────────────────────────────────────────

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8' }).trim()
}

function getLastTag(): string | null {
  try {
    return git('describe --tags --abbrev=0')
  } catch {
    return null
  }
}

function getInitialCommit(): string {
  return git('rev-list --max-parents=0 HEAD')
}

function getChangedFiles(since: string, pluginDir: string): string[] {
  const raw = git(`diff --name-only ${since}..HEAD -- ${pluginDir}`)
  return raw ? raw.split('\n').filter(Boolean) : []
}

function getCommitsSince(since: string, pluginDir: string): string[] {
  try {
    const raw = git(`log ${since}..HEAD --format="%s" -- ${pluginDir}`)
    return raw ? raw.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

function readPluginVersion(pluginName: string): string {
  const filePath = `${ROOT}/plugins/${pluginName}/src/index.ts`
  const content = readFileSync(filePath, 'utf-8')
  const match = content.match(TS_VERSION_RE)
  if (!match) throw new Error(`Could not find version in ${filePath}`)
  return match[1]
}

function readRootVersion(): string {
  const pkgPath = `${ROOT}/package.json`
  const content = readFileSync(pkgPath, 'utf-8')
  const match = content.match(JSON_VERSION_RE)
  if (!match) throw new Error(`Could not find version in ${pkgPath}`)
  return match[1]
}

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

function updatePluginVersion(pluginName: string, newVersion: string): void {
  const filePath = `${ROOT}/plugins/${pluginName}/src/index.ts`
  let content = readFileSync(filePath, 'utf-8')
  content = content.replace(TS_VERSION_RE, `version: '${newVersion}'`)
  writeFileSync(filePath, content)
}

function updateRootVersion(newVersion: string): void {
  const pkgPath = `${ROOT}/package.json`
  let content = readFileSync(pkgPath, 'utf-8')
  content = content.replace(JSON_VERSION_RE, `"version": "${newVersion}"`)
  writeFileSync(pkgPath, content)
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
  // single plugin, patch only
  return bumpVersion(currentVersion, 'patch')
}

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log(dryRun ? '\n  DRY RUN - no files will be written\n' : '')

  // 1. Find last tag (or fall back to initial commit)
  const lastTag = getLastTag()
  const since = lastTag ?? getInitialCommit()
  console.log(lastTag
    ? `Last tag: ${lastTag}`
    : `No tags found, comparing against initial commit (${since.slice(0, 8)})`)

  // 2. Detect changed plugins
  const changedPlugins: { name: string; version: string; commits: string[] }[] = []

  for (const name of PLUGINS) {
    const dir = `plugins/${name}/`
    const changed = getChangedFiles(since, dir)
    if (changed.length > 0) {
      const version = readPluginVersion(name)
      const commits = getCommitsSince(since, dir)
      changedPlugins.push({ name, version, commits })
    }
  }

  if (changedPlugins.length === 0) {
    console.log('\nNo plugin changes detected since last release. Nothing to do.')
    process.exit(0)
  }

  console.log(`\nChanged plugins (${changedPlugins.length}):`)
  for (const p of changedPlugins) {
    console.log(`  - ${p.name} (current: ${p.version}, ${p.commits.length} commits)`)
  }

  // 3. Interactive bump selection
  const rl = createInterface({ input: stdin, output: stdout })
  const bumps = new Map<string, BumpKind>()
  const newVersions = new Map<string, string>()

  // Create a promise that rejects when the readline interface closes (EOF)
  let onRlClose: () => void
  const rlClosedPromise = new Promise<never>((_, reject) => {
    onRlClose = () => reject(new Error('EOF'))
  })
  rl.on('close', () => onRlClose())

  /** Ask a question, returning null on EOF */
  async function ask(prompt: string): Promise<string | null> {
    try {
      return await Promise.race([rl.question(prompt), rlClosedPromise])
    } catch {
      return null
    }
  }

  console.log('')
  for (const p of changedPlugins) {
    const answer = await ask(
      `  ${p.name} (${p.version}) — bump [p]atch / [m]inor / [M]ajor / [s]kip? `,
    )

    if (answer === null) {
      console.log(`    ${p.name}: skipped (no input)`)
      continue
    }

    const raw = answer.trim()
    const choice = raw.toLowerCase()
    let kind: BumpKind | null = null

    // 'M' (uppercase) = major, 'm' (lowercase) = minor
    if (raw === 'M') {
      kind = 'major'
    } else {
      switch (choice) {
        case 'p':
        case 'patch':
          kind = 'patch'
          break
        case 'm':
        case 'minor':
          kind = 'minor'
          break
        case 'major':
          kind = 'major'
          break
        case 's':
        case 'skip':
        case '':
          kind = null
          break
        default:
          console.log(`    Unknown choice "${choice}", skipping.`)
          kind = null
      }
    }

    if (kind) {
      const next = bumpVersion(p.version, kind)
      bumps.set(p.name, kind)
      newVersions.set(p.name, next)
      console.log(`    ${p.name}: ${p.version} -> ${next}`)
    } else {
      console.log(`    ${p.name}: skipped`)
    }
  }

  rl.close()

  if (bumps.size === 0) {
    console.log('\nAll plugins skipped. Nothing to release.')
    process.exit(0)
  }

  // 4. Calculate global version
  const currentGlobal = readRootVersion()
  const newGlobal = calculateGlobalVersion(currentGlobal, bumps)
  console.log(`\nGlobal version: ${currentGlobal} -> ${newGlobal}`)

  // 5. Generate CHANGELOG entry
  const changelogLines: string[] = []
  changelogLines.push(`## v${newGlobal} (${todayISO()})`)
  changelogLines.push('')

  for (const p of changedPlugins) {
    const nextVer = newVersions.get(p.name)
    if (!nextVer) continue // skipped

    changelogLines.push(`### ${p.name} (${p.version} \u2192 ${nextVer})`)
    if (p.commits.length > 0) {
      for (const msg of p.commits) {
        changelogLines.push(`- ${msg}`)
      }
    } else {
      changelogLines.push('- (no commit messages)')
    }
    changelogLines.push('')
  }

  const changelogEntry = changelogLines.join('\n')

  console.log('\n--- CHANGELOG entry ---')
  console.log(changelogEntry)
  console.log('--- end ---')

  if (dryRun) {
    console.log('\n  DRY RUN complete. No files were modified.\n')
    return
  }

  // 6. Update plugin versions
  for (const [name, ver] of newVersions) {
    updatePluginVersion(name, ver)
    console.log(`Updated plugins/${name}/src/index.ts -> ${ver}`)
  }

  // 7. Update root package.json
  updateRootVersion(newGlobal)
  console.log(`Updated package.json -> ${newGlobal}`)

  // 8. Update CHANGELOG.md
  const changelogPath = `${ROOT}/CHANGELOG.md`
  if (existsSync(changelogPath)) {
    const existing = readFileSync(changelogPath, 'utf-8')
    writeFileSync(changelogPath, changelogEntry + '\n' + existing)
  } else {
    writeFileSync(changelogPath, '# Changelog\n\n' + changelogEntry + '\n')
  }
  console.log('Updated CHANGELOG.md')

  // 9. Git commit + tag
  const filesToAdd = [
    'package.json',
    'CHANGELOG.md',
    ...[...newVersions.keys()].map(n => `plugins/${n}/src/index.ts`),
  ]

  for (const f of filesToAdd) {
    git(`add ${f}`)
  }

  const tag = `v${newGlobal}`
  git(`commit -m "release: ${tag}"`)
  git(`tag ${tag}`)

  console.log(`\nCommitted and tagged: ${tag}`)
  console.log('Run `git push && git push --tags` to publish.')
}

main().catch((err) => {
  console.error('Release failed:', err)
  process.exit(1)
})
