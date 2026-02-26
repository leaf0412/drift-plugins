import type { DriftToolRegistration, DriftToolResult } from '@drift/core'
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

type ToolRegistration = Omit<DriftToolRegistration, 'pluginId' | 'source'>

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Drift',
      GIT_AUTHOR_EMAIL: 'drift@local',
      GIT_COMMITTER_NAME: 'Drift',
      GIT_COMMITTER_EMAIL: 'drift@local',
    },
  }).trim()
}

function buildTree(dir: string, prefix = '', maxDepth = 3, depth = 0): string {
  if (depth >= maxDepth) return ''
  const entries = readdirSync(dir).filter(
    (e) => !e.startsWith('.') && e !== 'node_modules',
  )
  const lines: string[] = []
  for (const entry of entries.sort()) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      lines.push(`${prefix}${entry}/`)
      lines.push(buildTree(full, prefix + '  ', maxDepth, depth + 1))
    } else {
      lines.push(`${prefix}${entry}`)
    }
  }
  return lines.filter(Boolean).join('\n')
}

export function buildCodingTools(
  getWorkspacePath: () => string | null,
): ToolRegistration[] {
  const withWorkspace =
    (fn: (cwd: string, args: any) => DriftToolResult) =>
    async (args: unknown): Promise<DriftToolResult> => {
      const cwd = getWorkspacePath()
      if (!cwd)
        return {
          success: false,
          output: '',
          error: 'No active coding workspace',
        }
      try {
        return fn(cwd, args)
      } catch (err) {
        return { success: false, output: '', error: String(err) }
      }
    }

  return [
    {
      name: 'code_git_status',
      description: 'Show git status of the current coding workspace',
      parametersSchema: { type: 'object', properties: {}, required: [] },
      execute: withWorkspace((cwd) => ({
        success: true,
        output: git(['status', '--short'], cwd) || '(clean)',
      })),
    },
    {
      name: 'code_git_diff',
      description:
        'Show git diff of current changes. Use --staged for staged changes.',
      parametersSchema: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged diff' },
        },
      },
      execute: withWorkspace((cwd, args) => {
        const gitArgs = (args as any)?.staged ? ['diff', '--staged'] : ['diff']
        return {
          success: true,
          output: git(gitArgs, cwd) || '(no changes)',
        }
      }),
    },
    {
      name: 'code_git_commit',
      description: 'Stage all changes and commit with a message',
      parametersSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
        },
        required: ['message'],
      },
      execute: withWorkspace((cwd, args) => {
        const msg = (args as any).message
        git(['add', '-A'], cwd)
        const out = git(['commit', '-m', msg], cwd)
        return { success: true, output: out }
      }),
    },
    {
      name: 'code_git_log',
      description: 'Show recent git log',
      parametersSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'number',
            description: 'Number of commits (default 10)',
          },
        },
      },
      execute: withWorkspace((cwd, args) => {
        const n = (args as any)?.count || 10
        return {
          success: true,
          output: git(['log', '--oneline', `-${n}`], cwd),
        }
      }),
    },
    {
      name: 'code_tree',
      description:
        'Show project directory tree (excludes .git and node_modules)',
      parametersSchema: {
        type: 'object',
        properties: {
          depth: {
            type: 'number',
            description: 'Max depth (default 3)',
          },
        },
      },
      execute: withWorkspace((cwd, args) => {
        const depth = (args as any)?.depth || 3
        return { success: true, output: buildTree(cwd, '', depth) }
      }),
    },
  ]
}
