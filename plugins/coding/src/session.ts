import type Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { createWorkspaceDir, removeWorkspaceDir, initGitRepo } from './sandbox.js'

export interface CodingSession {
  id: string
  chat_session_id: string | null
  project_name: string
  workspace_path: string
  git_url: string
  permission_mode: string
  status: string
  created_at: string
  updated_at: string
}

export interface CreateSessionOpts {
  projectName: string
  permissionMode?: string
  gitUrl?: string
}

export async function createCodingSession(
  db: Database.Database,
  opts: CreateSessionOpts,
): Promise<CodingSession> {
  const id = nanoid(12)
  const now = new Date().toISOString()
  const workspacePath = await createWorkspaceDir(id)

  const session: CodingSession = {
    id,
    chat_session_id: null,
    project_name: opts.projectName,
    workspace_path: workspacePath,
    git_url: opts.gitUrl || '',
    permission_mode: opts.permissionMode || 'supervised',
    status: 'active',
    created_at: now,
    updated_at: now,
  }

  db.prepare(`
    INSERT INTO coding_sessions (id, chat_session_id, project_name, workspace_path, git_url, permission_mode, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, session.chat_session_id, session.project_name, session.workspace_path, session.git_url, session.permission_mode, session.status, session.created_at, session.updated_at)

  return session
}

export function getCodingSession(db: Database.Database, id: string): CodingSession | null {
  return db.prepare('SELECT * FROM coding_sessions WHERE id = ?').get(id) as CodingSession | null
}

export function listCodingSessions(db: Database.Database): CodingSession[] {
  return db.prepare('SELECT * FROM coding_sessions WHERE status != ? ORDER BY updated_at DESC').all('deleted') as CodingSession[]
}

export function updateCodingSession(db: Database.Database, id: string, updates: Partial<Pick<CodingSession, 'chat_session_id' | 'permission_mode' | 'status'>>): void {
  const sets: string[] = ['updated_at = ?']
  const values: unknown[] = [new Date().toISOString()]

  if (updates.chat_session_id !== undefined) { sets.push('chat_session_id = ?'); values.push(updates.chat_session_id) }
  if (updates.permission_mode !== undefined) { sets.push('permission_mode = ?'); values.push(updates.permission_mode) }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status) }

  values.push(id)
  db.prepare(`UPDATE coding_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export async function deleteCodingSession(db: Database.Database, id: string): Promise<void> {
  const session = getCodingSession(db, id)
  if (session) {
    await removeWorkspaceDir(id)
    updateCodingSession(db, id, { status: 'deleted' })
  }
}
