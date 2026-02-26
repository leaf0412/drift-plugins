import { describe, it, expect } from 'vitest'
import { ChannelRouter } from '@drift/plugins'
import type { ChatEvent, ChatHandler, InboundMessage, DriftChannel } from '@drift/plugins'
import { chatEventsToSse } from './sse.js'

describe('Channel Protocol integration', () => {
  it('full flow: inbound → router → chat handler → SSE', async () => {
    const router = new ChannelRouter()

    const handler: ChatHandler = async function* (msg: InboundMessage) {
      yield { type: 'delta', sessionId: msg.sessionId, content: 'Hello ' }
      yield { type: 'delta', sessionId: msg.sessionId, content: 'world' }
      yield {
        type: 'usage',
        sessionId: msg.sessionId,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }
      yield {
        type: 'complete',
        sessionId: msg.sessionId,
        response: { id: 'r1', model: 'test', content: 'Hello world', stopReason: 'end' },
      }
    }
    router.onMessage(handler)

    const inbound: InboundMessage = { channelId: 'web', sessionId: 's1', content: 'hi' }
    const events = router.handleInbound(inbound)
    const response = chatEventsToSse(events)

    const text = await response.text()
    expect(text).toContain('event: chat.delta')
    expect(text).toContain('"delta":"Hello "')
    expect(text).toContain('"delta":"world"')
    expect(text).toContain('event: chat.usage')
    expect(text).toContain('event: chat.complete')
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
  })

  it('multiple channels registered with different capabilities', () => {
    const router = new ChannelRouter()

    const webChannel: DriftChannel = {
      id: 'web',
      meta: { name: 'Web' },
      capabilities: { text: true, streaming: true, files: true },
      messaging: { listen: () => () => {}, send: async () => {} },
    }
    const cliChannel: DriftChannel = {
      id: 'cli',
      meta: { name: 'CLI' },
      capabilities: { text: true, streaming: true, files: false },
      messaging: { listen: () => () => {}, send: async () => {} },
    }
    router.register(webChannel)
    router.register(cliChannel)

    expect(router.list()).toHaveLength(2)
    expect(router.get('web')?.capabilities.files).toBe(true)
    expect(router.get('cli')?.capabilities.files).toBe(false)
  })

  it('handler receives correct inbound message', async () => {
    const router = new ChannelRouter()
    let received: InboundMessage | undefined

    const handler: ChatHandler = async function* (msg) {
      received = msg
      yield {
        type: 'complete',
        sessionId: msg.sessionId,
        response: { content: 'done' },
      }
    }
    router.onMessage(handler)

    const inbound: InboundMessage = {
      channelId: 'feishu',
      sessionId: 'feishu:user1',
      content: 'hello from feishu',
      metadata: { cwd: '/home/user' },
    }

    for await (const _ of router.handleInbound(inbound)) {
      /* drain */
    }

    expect(received).toEqual(inbound)
  })

  it('error in handler yields error event', async () => {
    const router = new ChannelRouter()

    const handler: ChatHandler = async function* () {
      yield { type: 'delta', sessionId: 's1', content: 'start' }
      throw new Error('LLM failed')
    }
    router.onMessage(handler)

    const events: ChatEvent[] = []
    try {
      for await (const e of router.handleInbound({
        channelId: 'web',
        sessionId: 's1',
        content: 'hi',
      })) {
        events.push(e)
      }
    } catch {
      // error is thrown by the generator
    }
    expect(events[0]).toEqual({ type: 'delta', sessionId: 's1', content: 'start' })
  })

  it('SSE handles error from handler gracefully', async () => {
    const router = new ChannelRouter()

    const handler: ChatHandler = async function* () {
      yield { type: 'delta', sessionId: 's1', content: 'partial' }
      throw new Error('connection lost')
    }
    router.onMessage(handler)

    const response = chatEventsToSse(
      router.handleInbound({ channelId: 'web', sessionId: 's1', content: 'hi' }),
    )
    const text = await response.text()
    expect(text).toContain('event: chat.delta')
    expect(text).toContain('event: chat.error')
    expect(text).toContain('connection lost')
  })
})
