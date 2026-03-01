import { describe, it, expect } from 'vitest'
import { chatEventsToSse } from './sse.js'
import { createWebChannelPlugin } from './index.js'
import type { ChatEvent } from '@drift/plugins'

// ── Helpers ──────────────────────────────────────────────────

async function collectSse(events: ChatEvent[]): Promise<string> {
  async function* gen() {
    yield* events
  }
  const response = chatEventsToSse(gen())
  return await response.text()
}

// ── chatEventsToSse ──────────────────────────────────────────

describe('chatEventsToSse', () => {
  it('converts delta to chat.delta SSE', async () => {
    const text = await collectSse([{ type: 'delta', sessionId: 's1', content: 'hi' }])
    expect(text).toContain('event: chat.delta')
    expect(text).toContain('"delta":"hi"')
    expect(text).toContain('"sessionId":"s1"')
  })

  it('converts tool_start to chat.tool_start SSE', async () => {
    const text = await collectSse([
      { type: 'tool_start', sessionId: 's1', toolCall: { id: 't1', name: 'bash' } },
    ])
    expect(text).toContain('event: chat.tool_start')
    expect(text).toContain('"toolCall"')
  })

  it('converts tool_delta to chat.tool_delta SSE', async () => {
    const text = await collectSse([
      { type: 'tool_delta', sessionId: 's1', toolCallId: 't1', content: 'output' },
    ])
    expect(text).toContain('event: chat.tool_delta')
    expect(text).toContain('"delta":"output"')
  })

  it('converts tool_update to chat.tool_update SSE', async () => {
    const text = await collectSse([
      { type: 'tool_update', sessionId: 's1', toolCall: { id: 't1', status: 'running' } },
    ])
    expect(text).toContain('event: chat.tool_update')
  })

  it('converts tool_result to chat.tool_result SSE', async () => {
    const text = await collectSse([
      { type: 'tool_result', sessionId: 's1', toolCall: { id: 't1', output: 'done' } },
    ])
    expect(text).toContain('event: chat.tool_result')
  })

  it('converts tool_confirm to chat.tool_confirm SSE', async () => {
    const text = await collectSse([
      {
        type: 'tool_confirm',
        sessionId: 's1',
        toolCall: { id: 't1' },
        options: [{ id: 'allow', label: 'Allow' }],
      },
    ])
    expect(text).toContain('event: chat.tool_confirm')
    expect(text).toContain('"options"')
  })

  it('converts usage to chat.usage SSE', async () => {
    const text = await collectSse([
      {
        type: 'usage',
        sessionId: 's1',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    ])
    expect(text).toContain('event: chat.usage')
    expect(text).toContain('"promptTokens":10')
  })

  it('converts complete to chat.complete SSE', async () => {
    const text = await collectSse([
      { type: 'complete', sessionId: 's1', response: { id: 'r1', content: 'hi' } },
    ])
    expect(text).toContain('event: chat.complete')
    expect(text).toContain('"response"')
  })

  it('converts error to chat.error SSE', async () => {
    const text = await collectSse([{ type: 'error', sessionId: 's1', error: 'fail' }])
    expect(text).toContain('event: chat.error')
    expect(text).toContain('"error":"fail"')
  })

  it('converts user_stored to chat.user_stored SSE', async () => {
    const text = await collectSse([
      { type: 'user_stored', sessionId: 's1', userMessageId: 'u1' },
    ])
    expect(text).toContain('event: chat.user_stored')
    expect(text).toContain('"userMessageId":"u1"')
  })

  it('converts assistant_stored to chat.assistant_stored SSE', async () => {
    const text = await collectSse([
      { type: 'assistant_stored', sessionId: 's1', assistantMessageId: 'a1' },
    ])
    expect(text).toContain('event: chat.assistant_stored')
    expect(text).toContain('"assistantMessageId":"a1"')
  })

  it('returns correct SSE headers', async () => {
    async function* gen(): AsyncGenerator<ChatEvent> {}
    const response = chatEventsToSse(gen())
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(response.headers.get('Connection')).toBe('keep-alive')
  })

  it('handles stream errors gracefully', async () => {
    async function* gen(): AsyncGenerator<ChatEvent> {
      yield { type: 'delta', sessionId: 's1', content: 'hi' }
      throw new Error('stream broke')
    }
    const response = chatEventsToSse(gen())
    const text = await response.text()
    expect(text).toContain('event: chat.error')
    expect(text).toContain('stream broke')
  })

  it('emits multiple events in correct SSE format', async () => {
    const text = await collectSse([
      { type: 'delta', sessionId: 's1', content: 'hello' },
      { type: 'delta', sessionId: 's1', content: ' world' },
      { type: 'complete', sessionId: 's1', response: { id: 'r1' } },
    ])
    // Verify each event is separated by double newline
    const parts = text.split('\n\n').filter((p) => p.trim())
    expect(parts).toHaveLength(3)
  })
})

// ── createWebChannelPlugin ───────────────────────────────────

describe('createWebChannelPlugin', () => {
  it('has correct name', () => {
    const plugin = createWebChannelPlugin()
    expect(plugin.name).toBe('web-channel')
  })
})
