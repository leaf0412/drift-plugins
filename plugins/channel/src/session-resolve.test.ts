import { describe, it, expect } from 'vitest'
import { resolveSessionKey, sessionNamespace, resolveSessionId } from './session-resolve.js'
import type { InboundMessage } from './types.js'

describe('resolveSessionKey', () => {
  it('extracts channelId and userId from metadata', () => {
    const msg: InboundMessage = {
      channelId: 'telegram',
      sessionId: '',
      content: 'hi',
      metadata: { userId: 'u123' },
    }
    const key = resolveSessionKey(msg)
    expect(key).toEqual({ channelId: 'telegram', userId: 'u123' })
  })

  it('defaults userId to "owner" when not in metadata', () => {
    const msg: InboundMessage = { channelId: 'web', sessionId: '', content: 'hi' }
    const key = resolveSessionKey(msg)
    expect(key).toEqual({ channelId: 'web', userId: 'owner' })
  })
})

describe('sessionNamespace', () => {
  it('returns channelId:userId', () => {
    expect(sessionNamespace({ channelId: 'feishu', userId: 'ou_abc' })).toBe('feishu:ou_abc')
  })
})

describe('resolveSessionId', () => {
  it('generates namespaced id when sessionId is empty', () => {
    const msg: InboundMessage = { channelId: 'web', sessionId: '', content: 'hi', metadata: { userId: 'owner' } }
    const resolved = resolveSessionId(msg)
    expect(resolved).toMatch(/^web:owner:/)
    expect(resolved.length).toBeGreaterThan('web:owner:'.length)
  })

  it('adds namespace prefix when sessionId has no prefix', () => {
    const msg: InboundMessage = { channelId: 'telegram', sessionId: 'abc123', content: 'hi', metadata: { userId: 'u1' } }
    const resolved = resolveSessionId(msg)
    expect(resolved).toBe('telegram:u1:abc123')
  })

  it('preserves sessionId that already has correct prefix', () => {
    const msg: InboundMessage = { channelId: 'feishu', sessionId: 'feishu:ou_abc:sess1', content: 'hi', metadata: { userId: 'ou_abc' } }
    const resolved = resolveSessionId(msg)
    expect(resolved).toBe('feishu:ou_abc:sess1')
  })
})
