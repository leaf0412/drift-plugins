import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function listTree(dir: string, prefix: string, depth: number, lines: string[], maxLines: number): void {
  if (depth <= 0 || lines.length >= maxLines) return
  let entries: string[]
  try { entries = readdirSync(dir).sort() } catch { return }
  for (const entry of entries) {
    if (lines.length >= maxLines) break
    if (entry === '.git' || entry === 'node_modules') continue
    lines.push(prefix + entry)
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) {
        listTree(full, prefix + entry + '/', depth - 1, lines, maxLines)
      }
    } catch { /* skip unreadable */ }
  }
}

export function buildCodingPrompt(workspacePath: string, projectName: string): string {
  const parts: string[] = []

  parts.push(`## Coding Agent Mode`)
  parts.push(`You are working on project "${projectName}" in workspace: ${workspacePath}`)
  parts.push(`All file operations are scoped to this workspace directory.`)
  parts.push('')

  // Project tree (compact)
  try {
    const lines: string[] = []
    listTree(workspacePath, './', 3, lines, 100)
    if (lines.length > 0) {
      parts.push('### Project Structure')
      parts.push('```')
      parts.push(lines.join('\n'))
      parts.push('```')
      parts.push('')
    }
  } catch { /* skip */ }

  // Detect config files for context
  const configHints: string[] = []
  const configs: Record<string, string> = {
    'package.json': 'Node.js project',
    'Cargo.toml': 'Rust project',
    'go.mod': 'Go project',
    'pyproject.toml': 'Python project',
    'requirements.txt': 'Python project',
    'pom.xml': 'Java/Maven project',
    '.editorconfig': 'Has EditorConfig',
    'tsconfig.json': 'TypeScript project',
  }
  for (const [file, hint] of Object.entries(configs)) {
    if (existsSync(join(workspacePath, file))) configHints.push(hint)
  }
  if (configHints.length) {
    parts.push(`### Detected: ${configHints.join(', ')}`)
    parts.push('')
  }

  // Read project README for context (first 100 lines)
  for (const readme of ['README.md', 'readme.md', 'README.txt']) {
    const p = join(workspacePath, readme)
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8').split('\n').slice(0, 100).join('\n')
      parts.push('### README (excerpt)')
      parts.push('```')
      parts.push(content)
      parts.push('```')
      parts.push('')
      break
    }
  }

  parts.push('### Available Tools')
  parts.push('- `code_git_status` — Check git status')
  parts.push('- `code_git_diff` — View changes')
  parts.push('- `code_git_commit` — Commit changes')
  parts.push('- `code_git_log` — View commit history')
  parts.push('- `code_tree` — View project structure')
  parts.push('')
  parts.push('### Guidelines')
  parts.push('- IMPORTANT: All file operations must stay within the workspace directory. Do not use absolute paths outside the project.')
  parts.push('- Commit frequently with descriptive messages')
  parts.push('- Run tests after changes when possible')
  parts.push('- Keep changes focused on the requested task')
  parts.push('- Use code_git_diff to review before committing')

  return parts.join('\n')
}
