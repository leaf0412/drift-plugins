import { describe, it, expect, vi } from 'vitest'
import { AuthGuard } from './auth.js'
import type { InboundMessage, ChannelAuthConfig } from './types.js'

describe('AuthGuard', () => {
  describe('token mode', () => {
    const config: ChannelAuthConfig = {
      mode: 'token',
      tokens: {
        'dk-abc': { userId: 'yb', permissions: ['chat', 'mind'] },
        'dk-guest': { userId: 'guest' },
      },
    }

    it('allows valid token and resolves userId', async () => {
      const guard = new AuthGuard(config, 'web')
      const msg: InboundMessage = { channelId: 'web', sessionId: '', content: 'hi', metadata: { authToken: 'dk-abc' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
      expect(result.userId).toBe('yb')
    })

    it('also checks daemon authToken', async () => {
      const guard = new AuthGuard(config, 'web', { daemonToken: 'dk-daemon' })
      const msg: InboundMessage = { channelId: 'web', sessionId: '', content: 'hi', metadata: { authToken: 'dk-daemon' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
      expect(result.userId).toBe('owner')
    })

    it('rejects invalid token', async () => {
      const guard = new AuthGuard(config, 'web')
      const msg: InboundMessage = { channelId: 'web', sessionId: '', content: 'hi', metadata: { authToken: 'bad' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Invalid token')
    })

    it('rejects missing token', async () => {
      const guard = new AuthGuard(config, 'web')
      const msg: InboundMessage = { channelId: 'web', sessionId: '', content: 'hi' }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(false)
    })
  })

  describe('whitelist mode', () => {
    const config: ChannelAuthConfig = { mode: 'whitelist', allowedUsers: ['u1', 'u2'] }

    it('allows whitelisted user', async () => {
      const guard = new AuthGuard(config, 'feishu')
      const msg: InboundMessage = { channelId: 'feishu', sessionId: '', content: 'hi', metadata: { userId: 'u1' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
      expect(result.userId).toBe('u1')
    })

    it('rejects non-whitelisted user', async () => {
      const guard = new AuthGuard(config, 'feishu')
      const msg: InboundMessage = { channelId: 'feishu', sessionId: '', content: 'hi', metadata: { userId: 'u3' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(false)
    })

    it('supports dynamic add via addUser', async () => {
      const guard = new AuthGuard(config, 'feishu')
      guard.addUser('u99')
      const msg: InboundMessage = { channelId: 'feishu', sessionId: '', content: 'hi', metadata: { userId: 'u99' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
    })
  })

  describe('pairing mode', () => {
    const config: ChannelAuthConfig = { mode: 'pairing', pairingTTL: 5 }

    it('rejects unpaired user with guidance', async () => {
      const guard = new AuthGuard(config, 'telegram')
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: 'hello', metadata: { userId: 'newUser' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('/pair')
    })

    it('accepts /pair command with valid code', async () => {
      const guard = new AuthGuard(config, 'telegram')
      const code = guard.generatePairingCode()
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: `/pair ${code}`, metadata: { userId: 'newUser' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
      expect(result.userId).toBe('newUser')
      expect(result.paired).toBe(true)
    })

    it('rejects /pair with invalid code', async () => {
      const guard = new AuthGuard(config, 'telegram')
      guard.generatePairingCode()
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: '/pair WRONG', metadata: { userId: 'u1' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(false)
    })

    it('already paired user is allowed', async () => {
      const guard = new AuthGuard(config, 'telegram')
      const code = guard.generatePairingCode()
      const pairMsg: InboundMessage = { channelId: 'telegram', sessionId: '', content: `/pair ${code}`, metadata: { userId: 'u1' } }
      await guard.check(pairMsg)
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: 'hello', metadata: { userId: 'u1' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
    })

    it('pairing code expires after TTL', async () => {
      const guard = new AuthGuard({ mode: 'pairing', pairingTTL: 0 }, 'telegram')
      const code = guard.generatePairingCode()
      await new Promise(r => setTimeout(r, 10))
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: `/pair ${code}`, metadata: { userId: 'u1' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('expired')
    })

    it('calls onPair callback when pairing succeeds', async () => {
      const onPair = vi.fn()
      const guard = new AuthGuard(config, 'telegram', { onPair })
      const code = guard.generatePairingCode()
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: `/pair ${code}`, metadata: { userId: 'u1' } }
      await guard.check(msg)
      expect(onPair).toHaveBeenCalledOnce()
      expect(onPair).toHaveBeenCalledWith('telegram', 'u1')
    })

    it('does not call onPair when pairing fails', async () => {
      const onPair = vi.fn()
      const guard = new AuthGuard(config, 'telegram', { onPair })
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: '/pair WRONG', metadata: { userId: 'u1' } }
      await guard.check(msg)
      expect(onPair).not.toHaveBeenCalled()
    })
  })

  describe('loadPairedUsers', () => {
    it('pre-populates paired users from DB data', async () => {
      const guard = new AuthGuard({ mode: 'pairing' }, 'telegram')
      guard.loadPairedUsers(['u1', 'u2'])
      const msg: InboundMessage = { channelId: 'telegram', sessionId: '', content: 'hello', metadata: { userId: 'u1' } }
      const result = await guard.check(msg)
      expect(result.allowed).toBe(true)
      expect(result.userId).toBe('u1')
    })

    it('merges with allowedUsers from config', async () => {
      const guard = new AuthGuard({ mode: 'whitelist', allowedUsers: ['static-user'] }, 'feishu')
      guard.loadPairedUsers(['db-user'])
      const msg1: InboundMessage = { channelId: 'feishu', sessionId: '', content: 'hi', metadata: { userId: 'static-user' } }
      const msg2: InboundMessage = { channelId: 'feishu', sessionId: '', content: 'hi', metadata: { userId: 'db-user' } }
      expect((await guard.check(msg1)).allowed).toBe(true)
      expect((await guard.check(msg2)).allowed).toBe(true)
    })
  })
})
