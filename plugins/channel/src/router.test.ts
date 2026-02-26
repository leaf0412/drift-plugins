import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChannelRouter } from './router.js'
import type { DriftChannel, InboundMessage, OutboundMessage, ChatEvent, ChatHandler } from './types.js'
import type { ResolvedChannelConfig } from './config-merge.js'

// ── Helpers ─────────────────────────────────────────────────

function makeChannel(id: string): DriftChannel & { sentMessages: OutboundMessage[] } {
  const sentMessages: OutboundMessage[] = []
  return {
    id,
    meta: { name: id },
    capabilities: { text: true },
    messaging: {
      listen: (_handler) => () => {},
      send: async (msg) => { sentMessages.push(msg) },
    },
    sentMessages,
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('ChannelRouter', () => {
  let router: ChannelRouter

  beforeEach(() => {
    router = new ChannelRouter()
  })

  describe('register / list', () => {
    it('registers a channel and lists it', () => {
      const ch = makeChannel('web')
      router.register(ch)
      expect(router.list()).toHaveLength(1)
      expect(router.list()[0].id).toBe('web')
    })

    it('get() returns the channel by id', () => {
      const ch = makeChannel('cli')
      router.register(ch)
      expect(router.get('cli')).toBe(ch)
    })

    it('get() returns undefined for unknown id', () => {
      expect(router.get('unknown')).toBeUndefined()
    })

    it('registers multiple channels', () => {
      router.register(makeChannel('web'))
      router.register(makeChannel('cli'))
      router.register(makeChannel('feishu'))
      expect(router.list()).toHaveLength(3)
    })

    it('duplicate id overwrites the previous channel', () => {
      const ch1 = makeChannel('web')
      const ch2 = makeChannel('web')
      router.register(ch1)
      router.register(ch2)
      expect(router.list()).toHaveLength(1)
      expect(router.get('web')).toBe(ch2)
    })
  })

  describe('dispatch', () => {
    it('routes InboundMessage to the matching channel.messaging.send()', async () => {
      const ch = makeChannel('web')
      router.register(ch)

      const reply: OutboundMessage = { type: 'text', content: 'hello back' }
      const msg: InboundMessage = { channelId: 'web', sessionId: 'sess-1', content: 'hello' }

      await router.dispatch(msg, reply)

      expect(ch.sentMessages).toHaveLength(1)
      expect(ch.sentMessages[0].content).toBe('hello back')
    })

    it('throws when channel is not registered', async () => {
      const msg: InboundMessage = { channelId: 'missing', sessionId: 's', content: 'hi' }
      const reply: OutboundMessage = { type: 'text', content: 'yo' }

      await expect(router.dispatch(msg, reply)).rejects.toThrow('Channel "missing" not registered')
    })

    it('passes metadata through to send', async () => {
      const ch = makeChannel('cli')
      router.register(ch)

      const reply: OutboundMessage = {
        type: 'text',
        content: 'response',
        metadata: { requestId: 'abc' },
      }
      const msg: InboundMessage = { channelId: 'cli', sessionId: 's', content: 'q' }

      await router.dispatch(msg, reply)

      expect(ch.sentMessages[0].metadata?.requestId).toBe('abc')
    })
  })

  describe('unregister', () => {
    it('removes a channel by id', () => {
      router.register(makeChannel('web'))
      router.register(makeChannel('cli'))
      router.unregister('web')
      expect(router.list()).toHaveLength(1)
      expect(router.get('web')).toBeUndefined()
    })

    it('unregister on unknown id is a no-op', () => {
      router.register(makeChannel('web'))
      expect(() => router.unregister('nope')).not.toThrow()
      expect(router.list()).toHaveLength(1)
    })
  })
})

// ── Chat flow tests ─────────────────────────────────────────

describe('ChannelRouter chat flow', () => {
  it('onMessage registers a ChatHandler', () => {
    const router = new ChannelRouter()
    const handler: ChatHandler = async function* () {}
    router.onMessage(handler)
    expect(router.hasHandler()).toBe(true)
  })

  it('hasHandler returns false when no handler', () => {
    const router = new ChannelRouter()
    expect(router.hasHandler()).toBe(false)
  })

  it('handleInbound yields ChatEvents from handler', async () => {
    const router = new ChannelRouter()
    const handler: ChatHandler = async function* (msg) {
      yield { type: 'delta', sessionId: msg.sessionId, content: 'hello' } as ChatEvent
      yield { type: 'complete', sessionId: msg.sessionId, response: { id: '1', model: 'test', content: 'hello', stopReason: 'end' } } as ChatEvent
    }
    router.onMessage(handler)

    const events: ChatEvent[] = []
    for await (const e of router.handleInbound({ channelId: 'web', sessionId: 's1', content: 'hi' })) {
      events.push(e)
    }

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'delta', sessionId: 's1', content: 'hello' })
    expect(events[1].type).toBe('complete')
  })

  it('handleInbound throws if no handler registered', async () => {
    const router = new ChannelRouter()
    const gen = router.handleInbound({ channelId: 'web', sessionId: 's1', content: 'hi' })
    await expect(gen.next()).rejects.toThrow('No chat handler registered')
  })

  it('handleInbound passes inbound message to handler', async () => {
    const router = new ChannelRouter()
    let received: any
    const handler: ChatHandler = async function* (msg) {
      received = msg
    }
    router.onMessage(handler)

    // exhaust generator
    for await (const _ of router.handleInbound({ channelId: 'cli', sessionId: 's2', content: 'test', metadata: { cwd: '/tmp' } })) {}

    expect(received).toEqual({ channelId: 'cli', sessionId: 's2', content: 'test', metadata: { cwd: '/tmp' } })
  })
})

// ── Gateway pipeline tests ──────────────────────────────────

describe('ChannelRouter gateway pipeline', () => {
  it('auth rejects → yields error and stops', async () => {
    const router = new ChannelRouter()
    const handler: ChatHandler = async function* () {
      yield { type: 'delta', sessionId: 's', content: 'should not reach' } as ChatEvent
    }
    router.onMessage(handler)
    router.setChannelConfig('secure', { auth: { mode: 'whitelist', allowedUsers: ['allowed'] }, agent: null })

    const events: ChatEvent[] = []
    for await (const e of router.handleInbound({ channelId: 'secure', sessionId: '', content: 'hi', metadata: { userId: 'intruder' } })) {
      events.push(e)
    }

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('error')
  })

  it('session id gets namespace prefix', async () => {
    const router = new ChannelRouter()
    let receivedMsg: InboundMessage | undefined
    const handler: ChatHandler = async function* (msg) { receivedMsg = msg }
    router.onMessage(handler)
    router.setChannelConfig('telegram', { auth: null, agent: null })

    for await (const _ of router.handleInbound({ channelId: 'telegram', sessionId: 'abc', content: 'hi', metadata: { userId: 'u1' } })) {}

    expect(receivedMsg!.sessionId).toBe('telegram:u1:abc')
  })

  it('empty sessionId gets generated with namespace', async () => {
    const router = new ChannelRouter()
    let receivedMsg: InboundMessage | undefined
    const handler: ChatHandler = async function* (msg) { receivedMsg = msg }
    router.onMessage(handler)
    router.setChannelConfig('web', { auth: null, agent: null })

    for await (const _ of router.handleInbound({ channelId: 'web', sessionId: '', content: 'hi', metadata: { userId: 'owner' } })) {}

    expect(receivedMsg!.sessionId).toMatch(/^web:owner:/)
  })

  it('agent config is injected into metadata', async () => {
    const router = new ChannelRouter()
    let receivedMsg: InboundMessage | undefined
    const handler: ChatHandler = async function* (msg) { receivedMsg = msg }
    router.onMessage(handler)
    router.setChannelConfig('telegram', { auth: null, agent: { model: 'claude-haiku-4-5', tools: ['mind'] } })

    for await (const _ of router.handleInbound({ channelId: 'telegram', sessionId: '', content: 'hi', metadata: { userId: 'u1' } })) {}

    expect(receivedMsg!.metadata?.agentConfig).toEqual({ model: 'claude-haiku-4-5', tools: ['mind'] })
  })

  it('no channel config → pass through unchanged (backward compatible)', async () => {
    const router = new ChannelRouter()
    let receivedMsg: InboundMessage | undefined
    const handler: ChatHandler = async function* (msg) { receivedMsg = msg }
    router.onMessage(handler)

    for await (const _ of router.handleInbound({ channelId: 'web', sessionId: 'existing-id', content: 'hi' })) {}

    expect(receivedMsg!.sessionId).toBe('existing-id')
  })

  it('auth pass + session resolve + agent route all work together', async () => {
    const router = new ChannelRouter()
    let receivedMsg: InboundMessage | undefined
    const handler: ChatHandler = async function* (msg) { receivedMsg = msg }
    router.onMessage(handler)
    router.setChannelConfig('feishu', {
      auth: { mode: 'whitelist', allowedUsers: ['ou_abc'] },
      agent: { model: 'claude-sonnet-4-6', tools: ['mind', 'cron'] },
    })

    for await (const _ of router.handleInbound({ channelId: 'feishu', sessionId: '', content: 'hello', metadata: { userId: 'ou_abc' } })) {}

    expect(receivedMsg!.sessionId).toMatch(/^feishu:ou_abc:/)
    expect(receivedMsg!.metadata?.agentConfig).toEqual({ model: 'claude-sonnet-4-6', tools: ['mind', 'cron'] })
    expect(receivedMsg!.metadata?.userId).toBe('ou_abc')
  })
})
