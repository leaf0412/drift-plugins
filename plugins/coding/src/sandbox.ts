import { join, resolve } from 'node:path'
import { mkdir, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const DATA_DIR = process.env.DRIFT_DATA_DIR || join(process.env.HOME || '~', '.drift')
export const WORKSPACES_DIR = join(DATA_DIR, 'workspaces')

export async function createWorkspaceDir(sessionId: string): Promise<string> {
  const dir = join(WORKSPACES_DIR, sessionId)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function removeWorkspaceDir(sessionId: string): Promise<void> {
  const dir = join(WORKSPACES_DIR, sessionId)
  await rm(dir, { recursive: true, force: true })
}

/**
 * Advisory path check — validates that filePath is inside workspaceRoot.
 * NOTE: The Claude Agent SDK's built-in tools (Bash/Read/Write/Edit) are
 * constrained by `cwd` + `permissionMode`, but absolute paths can still
 * escape the workspace. This function is exported for future use (e.g.
 * custom tool wrappers) but the primary sandbox is advisory via system prompt.
 */
export function isPathInWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = resolve(filePath)
  const root = resolve(workspaceRoot)
  return resolved.startsWith(root + '/') || resolved === root
}

export function initGitRepo(workspacePath: string): void {
  const opts = {
    cwd: workspacePath,
    stdio: 'ignore' as const,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Drift', GIT_AUTHOR_EMAIL: 'drift@local', GIT_COMMITTER_NAME: 'Drift', GIT_COMMITTER_EMAIL: 'drift@local' },
  }
  execFileSync('git', ['init'], opts)
  execFileSync('git', ['add', '-A'], opts)
  execFileSync('git', ['commit', '-m', 'initial: project uploaded', '--allow-empty'], opts)
}
