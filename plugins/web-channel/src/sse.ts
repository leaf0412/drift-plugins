// ── ChatEvent → SSE Response ────────────────────────────────────────
//
// Converts ChatEvent objects into an SSE Response with the exact same
// wire format that chat/stream.ts produces.  This lets the web-channel
// plugin stream events to HTTP clients using a channel-agnostic type.

import type { ChatEvent } from '@drift/plugins'

// ── SSE Event Name Map ───────────────────────────────────────────────

const SSE_EVENT_MAP: Record<string, string> = {
  delta: 'chat.delta',
  tool_start: 'chat.tool_start',
  tool_delta: 'chat.tool_delta',
  tool_update: 'chat.tool_update',
  tool_result: 'chat.tool_result',
  tool_confirm: 'chat.tool_confirm',
  usage: 'chat.usage',
  complete: 'chat.complete',
  error: 'chat.error',
  user_stored: 'chat.user_stored',
  assistant_stored: 'chat.assistant_stored',
}

// ── Build SSE Data Payload ───────────────────────────────────────────

function buildSseData(event: ChatEvent): Record<string, unknown> {
  switch (event.type) {
    case 'delta':
      return { delta: event.content, sessionId: event.sessionId }
    case 'tool_start':
      return { toolCall: event.toolCall, sessionId: event.sessionId }
    case 'tool_delta':
      return { toolCall: { id: event.toolCallId }, delta: event.content, sessionId: event.sessionId }
    case 'tool_update':
      return { toolCall: event.toolCall, sessionId: event.sessionId }
    case 'tool_result':
      return { toolCall: event.toolCall, sessionId: event.sessionId }
    case 'tool_confirm':
      return { toolCall: event.toolCall, options: event.options, sessionId: event.sessionId }
    case 'usage':
      return { usage: event.usage, sessionId: event.sessionId }
    case 'complete':
      return { response: event.response, sessionId: event.sessionId }
    case 'error':
      return { error: event.error, sessionId: event.sessionId }
    case 'user_stored':
      return { userMessageId: event.userMessageId, sessionId: event.sessionId }
    case 'assistant_stored':
      return { assistantMessageId: event.assistantMessageId, sessionId: event.sessionId }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Convert an async iterable of ChatEvent objects into an SSE Response.
 *
 * The wire format is identical to `streamResponse()` in chat/stream.ts:
 *   event: chat.delta\ndata: {"delta":"hi","sessionId":"s1"}\n\n
 */
export function chatEventsToSse(events: AsyncIterable<ChatEvent>): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (eventName: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`))
        }
        try {
          for await (const event of events) {
            const sseName = SSE_EVENT_MAP[event.type]
            if (sseName) {
              send(sseName, buildSseData(event))
            }
          }
        } catch (err) {
          send('chat.error', { error: err instanceof Error ? err.message : 'Stream failed' })
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
