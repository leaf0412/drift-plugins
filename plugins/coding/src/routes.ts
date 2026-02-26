import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  createCodingSession,
  getCodingSession,
  listCodingSessions,
  updateCodingSession,
  deleteCodingSession,
} from './session.js'
import { initGitRepo } from './sandbox.js'
import { buildCodingPrompt } from './prompt.js'

// ── Dependencies ──────────────────────────────────────────────

/**
 * ChatStreamFn is the `chat.stream` atom signature.
 * Takes a ChatRequest-like object and returns an async generator of
 * raw LLMStreamEvent objects with `sessionId`.
 */
type ChatStreamFn = (
  req: Record<string, unknown>,
) => AsyncGenerator<Record<string, unknown> & { sessionId: string }>

export interface CodingRouteDeps {
  db: Database.Database
  getChatStream: () => ChatStreamFn | null
  setActiveWorkspace: (sessionId: string, path: string | null) => void
}

// ── SSE Helpers ───────────────────────────────────────────────

/**
 * Map raw LLMStreamEvent.type to SSE event names.
 * Follows the exact same naming convention as web-channel/sse.ts
 * but maps from raw LLMStreamEvent types (text_delta, tool_use_start, etc.)
 */
const SSE_EVENT_MAP: Record<string, string> = {
  text_delta: 'chat.delta',
  tool_use_start: 'chat.tool_start',
  tool_use_delta: 'chat.tool_delta',
  tool_use_update: 'chat.tool_update',
  tool_result: 'chat.tool_result',
  tool_confirm: 'chat.tool_confirm',
  complete: 'chat.complete',
  error: 'chat.error',
  user_stored: 'chat.user_stored',
  assistant_stored: 'chat.assistant_stored',
}

/**
 * Build SSE data payload from a raw LLMStreamEvent.
 * Extracts relevant fields based on event type.
 */
function buildSseData(event: Record<string, unknown>): Record<string, unknown> {
  const sid = event.sessionId
  switch (event.type as string) {
    case 'text_delta':
      return { delta: event.delta, sessionId: sid }
    case 'tool_use_start':
      return { toolCall: event.toolCall, sessionId: sid }
    case 'tool_use_delta':
      return { toolCall: event.toolCall, delta: event.delta, sessionId: sid }
    case 'tool_use_update':
      return { toolCall: event.toolCall, sessionId: sid }
    case 'tool_result':
      return { toolCall: event.toolCall, sessionId: sid }
    case 'tool_confirm':
      return { toolCall: event.toolCall, options: event.options, sessionId: sid }
    case 'complete': {
      const resp = event.response as Record<string, unknown> | undefined
      return { response: resp, sessionId: sid }
    }
    case 'error':
      return { error: event.error, sessionId: sid }
    case 'user_stored':
      return { userMessageId: event.userMessageId, sessionId: sid }
    case 'assistant_stored':
      return { assistantMessageId: event.assistantMessageId, sessionId: sid }
    default:
      return { ...event }
  }
}

/**
 * Convert a raw LLMStreamEvent async generator into an SSE Response.
 * Wire format: `event: chat.delta\ndata: {"delta":"hi","sessionId":"s1"}\n\n`
 */
function streamToSse(
  events: AsyncGenerator<Record<string, unknown> & { sessionId: string }>,
): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (eventName: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
          )
        }
        try {
          for await (const event of events) {
            const eventType = event.type as string
            const sseName = SSE_EVENT_MAP[eventType]
            if (sseName) {
              send(sseName, buildSseData(event))
            }
          }
        } catch (err) {
          send('chat.error', {
            error: err instanceof Error ? err.message : 'Stream failed',
          })
        } finally {
          controller.close()
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  )
}

// ── URL Validation ────────────────────────────────────────────

function validateGitUrl(url: string): string | null {
  if (url.length > 2048) return 'URL too long'
  if (/[\x00-\x1f]/.test(url)) return 'URL contains control characters'
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return `Protocol ${parsed.protocol} not allowed, use https://`
    const host = parsed.hostname
    if (host === 'localhost' || host.startsWith('127.') || host === '::1'
        || host.startsWith('10.') || host.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || host.startsWith('169.254.')) {
      return 'Internal/private URLs are not allowed'
    }
    return null
  } catch {
    return 'Invalid URL format'
  }
}

// ── Route Registration ────────────────────────────────────────

export function registerCodingRoutes(app: Hono, deps: CodingRouteDeps): void {
  const { db } = deps

  // ── POST /api/code/sessions — Create session ────────────────

  app.post('/api/code/sessions', async (c) => {
    const body = await c.req.json<{
      projectName: string
      permissionMode?: string
      gitUrl?: string
    }>()

    if (!body.projectName) {
      return c.json({ error: 'projectName is required' }, 400)
    }

    const validModes = ['full', 'supervised', 'readonly']
    if (body.permissionMode && !validModes.includes(body.permissionMode)) {
      return c.json({ error: `Invalid permissionMode. Must be one of: ${validModes.join(', ')}` }, 400)
    }

    if (body.gitUrl) {
      const urlError = validateGitUrl(body.gitUrl)
      if (urlError) return c.json({ error: urlError }, 400)
    }

    try {
      const session = await createCodingSession(db, {
        projectName: body.projectName,
        permissionMode: body.permissionMode,
        gitUrl: body.gitUrl,
      })

      // Clone or init git
      if (body.gitUrl) {
        try {
          execFileSync('git', ['clone', body.gitUrl, '.'], {
            cwd: session.workspace_path,
            stdio: 'ignore',
            timeout: 60_000,
          })
        } catch (err) {
          // Clean up on clone failure
          await deleteCodingSession(db, session.id)
          return c.json(
            {
              error: `git clone failed: ${err instanceof Error ? err.message : String(err)}`,
            },
            500,
          )
        }
      } else {
        initGitRepo(session.workspace_path)
      }

      return c.json({ session }, 201)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to create session' },
        500,
      )
    }
  })

  // ── GET /api/code/sessions — List sessions ──────────────────

  app.get('/api/code/sessions', (c) => {
    const sessions = listCodingSessions(db)
    return c.json({ sessions })
  })

  // ── GET /api/code/sessions/:id — Get session ───────────────

  app.get('/api/code/sessions/:id', (c) => {
    const session = getCodingSession(db, c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json({ session })
  })

  // ── DELETE /api/code/sessions/:id — Delete session ──────────

  app.delete('/api/code/sessions/:id', async (c) => {
    const session = getCodingSession(db, c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)

    await deleteCodingSession(db, session.id)
    return c.json({ ok: true })
  })

  // ── POST /api/code/chat — Chat with coding context (SSE) ───

  app.post('/api/code/chat', async (c) => {
    const body = await c.req.json<{
      codingSessionId: string
      message: string
      model?: string
    }>()

    if (!body.codingSessionId || !body.message) {
      return c.json({ error: 'codingSessionId and message are required' }, 400)
    }

    const session = getCodingSession(db, body.codingSessionId)
    if (!session) {
      return c.json({ error: 'Coding session not found' }, 404)
    }
    if (session.status !== 'active') {
      return c.json({ error: 'Coding session is not active' }, 400)
    }

    const chatStream = deps.getChatStream()
    if (!chatStream) {
      return c.json({ error: 'Chat plugin not available' }, 503)
    }

    // Build coding-specific system prompt
    const systemPrompt = buildCodingPrompt(session.workspace_path, session.project_name)

    // Use a prefixed sessionId to namespace coding sessions in the chat system
    const chatSessionId = `coding:${session.id}`

    // Update the chat_session_id reference if not set
    if (!session.chat_session_id) {
      updateCodingSession(db, session.id, { chat_session_id: chatSessionId })
    }

    // Activate workspace so registered tools resolve to the correct directory
    deps.setActiveWorkspace(chatSessionId, session.workspace_path)

    const events = chatStream({
      message: body.message,
      sessionId: chatSessionId,
      stream: true,
      cwd: session.workspace_path,
      clientType: 'web',
      systemPrompt,
      model: body.model,
      source: 'user',
    })

    // Wrap the generator to clear workspace when stream finishes
    const wrappedEvents = (async function* () {
      try {
        yield* events
      } finally {
        deps.setActiveWorkspace(chatSessionId, null)
      }
    })()

    return streamToSse(wrappedEvents)
  })

  // ── GET /api/code/diff/:id — Git diff for session ──────────

  app.get('/api/code/diff/:id', (c) => {
    const session = getCodingSession(db, c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)

    try {
      const diff = execFileSync('git', ['diff', 'HEAD'], {
        cwd: session.workspace_path,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim()

      // Also include staged changes
      const staged = execFileSync('git', ['diff', '--staged'], {
        cwd: session.workspace_path,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim()

      // Git log for context
      const log = execFileSync('git', ['log', '--oneline', '-20'], {
        cwd: session.workspace_path,
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim()

      return c.json({
        diff: diff || '(no unstaged changes)',
        staged: staged || '(no staged changes)',
        log,
      })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to get diff' },
        500,
      )
    }
  })

  // ── GET /api/code/download/:id — Download workspace as tar.gz ─

  app.get('/api/code/download/:id', async (c) => {
    const session = getCodingSession(db, c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)

    try {
      // Create tar.gz excluding .git and node_modules
      const tarProcess = execFileSync(
        'tar',
        ['czf', '-', '--exclude=.git', '--exclude=node_modules', '.'],
        {
          cwd: session.workspace_path,
          maxBuffer: 100 * 1024 * 1024, // 100MB
          timeout: 60_000,
        },
      )

      const filename = `${session.project_name.replace(/[^a-zA-Z0-9_-]/g, '_')}.tar.gz`

      return new Response(tarProcess, {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to create archive' },
        500,
      )
    }
  })
}
