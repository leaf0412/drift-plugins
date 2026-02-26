import { describe, it, expect } from 'vitest'
import type {
  DriftChannel,
  MessagingAdapter,
  StreamingAdapter,
  OutboundAdapter,
  ChannelMeta,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  ChatEvent,
  SessionKey,
  ChannelAuthConfig,
  AgentProfile,
  ChannelConfig,
} from './types.js'

describe('DriftChannel types (structural)', () => {
  it('constructs a minimal channel with only messaging adapter', () => {
    const adapter: MessagingAdapter = {
      listen: (handler) => {
        // no-op
        return () => {}
      },
      send: async (_msg: OutboundMessage) => {},
    }

    const channel: DriftChannel = {
      id: 'test',
      meta: { name: 'Test', description: 'test channel' },
      capabilities: { text: true },
      messaging: adapter,
    }

    expect(channel.id).toBe('test')
    expect(channel.meta.name).toBe('Test')
    expect(channel.capabilities.text).toBe(true)
    expect(typeof channel.messaging.send).toBe('function')
    expect(typeof channel.messaging.listen).toBe('function')
  })

  it('constructs a channel with optional streaming adapter', () => {
    const messaging: MessagingAdapter = {
      listen: () => () => {},
      send: async () => {},
    }

    const streaming: StreamingAdapter = {
      startStream: async (_sessionId: string) => {},
      write: async (_sessionId: string, _event: OutboundMessage) => {},
      end: async (_sessionId: string) => {},
    }

    const channel: DriftChannel = {
      id: 'web',
      meta: { name: 'Web', icon: 'browser' },
      capabilities: { text: true, streaming: true },
      messaging,
      streaming,
    }

    expect(channel.streaming).toBeDefined()
    expect(typeof channel.streaming!.startStream).toBe('function')
    expect(typeof channel.streaming!.write).toBe('function')
    expect(typeof channel.streaming!.end).toBe('function')
  })

  it('constructs a channel with optional outbound adapter', () => {
    const messaging: MessagingAdapter = {
      listen: () => () => {},
      send: async () => {},
    }

    const outbound: OutboundAdapter = {
      push: async (_msg: OutboundMessage) => {},
    }

    const channel: DriftChannel = {
      id: 'feishu',
      meta: { name: 'Feishu' },
      capabilities: { text: true },
      messaging,
      outbound,
    }

    expect(channel.outbound).toBeDefined()
    expect(typeof channel.outbound!.push).toBe('function')
  })

  it('InboundMessage carries channel, sessionId, content, metadata', () => {
    const msg: InboundMessage = {
      channelId: 'web',
      sessionId: 'sess-1',
      content: 'hello',
      metadata: { ip: '127.0.0.1' },
    }

    expect(msg.channelId).toBe('web')
    expect(msg.sessionId).toBe('sess-1')
    expect(msg.content).toBe('hello')
    expect(msg.metadata?.ip).toBe('127.0.0.1')
  })

  it('OutboundMessage carries type, content, metadata', () => {
    const msg: OutboundMessage = {
      type: 'text',
      content: 'response',
    }

    expect(msg.type).toBe('text')
    expect(msg.content).toBe('response')
  })

  it('OutboundMessage supports stream_delta and error types', () => {
    const delta: OutboundMessage = { type: 'stream_delta', content: 'partial...' }
    const error: OutboundMessage = { type: 'error', content: 'something went wrong' }

    expect(delta.type).toBe('stream_delta')
    expect(error.type).toBe('error')
  })
})

describe('ChatEvent type', () => {
  it('should type-check all event variants', () => {
    const events: ChatEvent[] = [
      { type: 'delta', sessionId: 's1', content: 'hello' },
      { type: 'tool_start', sessionId: 's1', toolCall: { id: 't1', name: 'bash' } },
      { type: 'tool_delta', sessionId: 's1', toolCallId: 't1', content: '...' },
      { type: 'tool_update', sessionId: 's1', toolCall: { id: 't1' } },
      { type: 'tool_result', sessionId: 's1', toolCall: { id: 't1', output: 'ok' } },
      { type: 'tool_confirm', sessionId: 's1', toolCall: { id: 't1' }, options: [] },
      { type: 'usage', sessionId: 's1', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
      { type: 'complete', sessionId: 's1', response: { id: 'r1', model: 'm', content: 'done', stopReason: 'end' } },
      { type: 'error', sessionId: 's1', error: 'fail' },
      { type: 'user_stored', sessionId: 's1', userMessageId: 'u1' },
      { type: 'assistant_stored', sessionId: 's1', assistantMessageId: 'a1' },
    ]
    expect(events).toHaveLength(11)
  })
})

describe('Gateway types', () => {
  it('SessionKey shape', () => {
    const key: SessionKey = { channelId: 'telegram', userId: 'u123' }
    expect(key.channelId).toBe('telegram')
    expect(key.userId).toBe('u123')
  })

  it('ChannelAuthConfig — token mode', () => {
    const cfg: ChannelAuthConfig = {
      mode: 'token',
      tokens: { 'abc': { userId: 'yb', permissions: ['chat'] } },
    }
    expect(cfg.mode).toBe('token')
  })

  it('ChannelAuthConfig — whitelist mode', () => {
    const cfg: ChannelAuthConfig = { mode: 'whitelist', allowedUsers: ['u1', 'u2'] }
    expect(cfg.allowedUsers).toHaveLength(2)
  })

  it('ChannelAuthConfig — pairing mode', () => {
    const cfg: ChannelAuthConfig = { mode: 'pairing', pairingTTL: 300 }
    expect(cfg.pairingTTL).toBe(300)
  })

  it('AgentProfile shape', () => {
    const p: AgentProfile = { model: 'claude-haiku-4-5', tools: ['mind'], maxTokens: 4096 }
    expect(p.model).toBe('claude-haiku-4-5')
  })

  it('ChannelConfig with false disables', () => {
    const cfg: ChannelConfig = { auth: false, agent: false }
    expect(cfg.auth).toBe(false)
    expect(cfg.agent).toBe(false)
  })
})
