import { describe, it, expect } from 'vitest'
import { resolveChannelConfig } from './config-merge.js'
import type { ChannelConfig, ChannelAuthConfig, AgentProfile } from './types.js'

describe('resolveChannelConfig', () => {
  const defaults: ChannelConfig = {
    auth: { mode: 'pairing', pairingTTL: 300 },
    agent: { model: 'claude-haiku-4-5', tools: ['mind'] },
  }

  it('returns defaults when no user override', () => {
    const result = resolveChannelConfig(defaults, undefined, false)
    expect(result.auth).toEqual({ mode: 'pairing', pairingTTL: 300 })
    expect(result.agent).toEqual({ model: 'claude-haiku-4-5', tools: ['mind'] })
  })

  it('user override merges with defaults', () => {
    const result = resolveChannelConfig(defaults, { agent: { model: 'claude-sonnet-4-6' } as AgentProfile }, false)
    expect((result.agent as AgentProfile).model).toBe('claude-sonnet-4-6')
    expect((result.agent as AgentProfile).tools).toEqual(['mind'])
  })

  it('external plugin: false disables auth', () => {
    const result = resolveChannelConfig(defaults, { auth: false }, false)
    expect(result.auth).toBeNull()
  })

  it('external plugin: false disables agent', () => {
    const result = resolveChannelConfig(defaults, { agent: false }, false)
    expect(result.agent).toBeNull()
  })

  it('builtin plugin: false is ignored, keeps defaults', () => {
    const result = resolveChannelConfig(defaults, { auth: false }, true)
    expect(result.auth).toEqual({ mode: 'pairing', pairingTTL: 300 })
  })

  it('builtin plugin: false agent is ignored', () => {
    const result = resolveChannelConfig(defaults, { agent: false }, true)
    expect(result.agent).toEqual({ model: 'claude-haiku-4-5', tools: ['mind'] })
  })

  it('no defaults, no override → both null', () => {
    const result = resolveChannelConfig({}, undefined, false)
    expect(result.auth).toBeNull()
    expect(result.agent).toBeNull()
  })

  it('user auth override merges into defaults', () => {
    const result = resolveChannelConfig(defaults, {
      auth: { allowedUsers: ['u1'] } as ChannelAuthConfig
    }, false)
    expect((result.auth as ChannelAuthConfig).mode).toBe('pairing')
    expect((result.auth as ChannelAuthConfig).allowedUsers).toEqual(['u1'])
  })
})
