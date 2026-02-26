import { join, resolve } from 'node:path'
import { mkdir, rm, stat } from 'node:fs/promises'
import { execSync } from 'node:child_process'

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

export function isPathInWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = resolve(filePath)
  const root = resolve(workspaceRoot)
  return resolved.startsWith(root + '/') || resolved === root
}

export function initGitRepo(workspacePath: string): void {
  execSync('git init', { cwd: workspacePath, stdio: 'ignore' })
  execSync('git add -A', { cwd: workspacePath, stdio: 'ignore' })
  execSync('git commit -m "initial: project uploaded" --allow-empty', {
    cwd: workspacePath,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Drift', GIT_AUTHOR_EMAIL: 'drift@local', GIT_COMMITTER_NAME: 'Drift', GIT_COMMITTER_EMAIL: 'drift@local' },
  })
}
