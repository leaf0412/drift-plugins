import { describe, it, expect, vi } from 'vitest'
import { resolveAgentConfig } from './agent-route.js'
import type { AgentProfile, AgentRouteConfig } from './types.js'

describe('resolveAgentConfig', () => {
  describe('static routing', () => {
    it('returns agent profile from config', async () => {
      const agent: AgentProfile = { model: 'claude-sonnet-4-6', tools: ['mind'] }
      const result = await resolveAgentConfig({ agent }, 'hello')
      expect(result).toEqual(agent)
    })

    it('returns null when agent is null', async () => {
      const result = await resolveAgentConfig({ agent: null }, 'hello')
      expect(result).toBeNull()
    })

    it('returns null when no agent config', async () => {
      const result = await resolveAgentConfig({}, 'hello')
      expect(result).toBeNull()
    })
  })

  describe('intent routing', () => {
    it('classifies and picks the matching profile', async () => {
      const config: AgentRouteConfig = {
        routing: 'intent',
        profiles: {
          coding: { model: 'claude-sonnet-4-6', tools: 'all' },
          casual: { model: 'claude-haiku-4-5', tools: ['mind'] },
        },
      }
      const mockClassifier = vi.fn().mockResolvedValue('coding')
      const result = await resolveAgentConfig({ agent: config }, 'write a python script', mockClassifier)
      expect(mockClassifier).toHaveBeenCalledWith('write a python script', ['coding', 'casual'])
      expect(result).toEqual({ model: 'claude-sonnet-4-6', tools: 'all' })
    })

    it('returns first profile when classifier returns unknown category', async () => {
      const config: AgentRouteConfig = {
        routing: 'intent',
        profiles: {
          coding: { model: 'claude-sonnet-4-6', tools: 'all' },
          casual: { model: 'claude-haiku-4-5', tools: ['mind'] },
        },
      }
      const mockClassifier = vi.fn().mockResolvedValue('unknown_category')
      const result = await resolveAgentConfig({ agent: config }, 'blah', mockClassifier)
      expect(result).toEqual({ model: 'claude-sonnet-4-6', tools: 'all' })
    })

    it('falls back to first profile when no classifier provided', async () => {
      const config: AgentRouteConfig = {
        routing: 'intent',
        profiles: {
          coding: { model: 'claude-sonnet-4-6', tools: 'all' },
        },
      }
      const result = await resolveAgentConfig({ agent: config }, 'hello')
      expect(result).toEqual({ model: 'claude-sonnet-4-6', tools: 'all' })
    })
  })
})
