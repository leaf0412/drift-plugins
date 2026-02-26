import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function buildCodingPrompt(workspacePath: string, projectName: string): string {
  const parts: string[] = []

  parts.push(`## Coding Agent Mode`)
  parts.push(`You are working on project "${projectName}" in workspace: ${workspacePath}`)
  parts.push(`All file operations are scoped to this workspace directory.`)
  parts.push('')

  // Project tree (compact)
  try {
    const tree = execSync('find . -maxdepth 3 -not -path "./.git/*" -not -path "*/node_modules/*" | head -100', {
      cwd: workspacePath, encoding: 'utf-8', timeout: 5000,
    }).trim()
    parts.push('### Project Structure')
    parts.push('```')
    parts.push(tree)
    parts.push('```')
    parts.push('')
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
  parts.push('- Commit frequently with descriptive messages')
  parts.push('- Run tests after changes when possible')
  parts.push('- Keep changes focused on the requested task')
  parts.push('- Use code_git_diff to review before committing')

  return parts.join('\n')
}
