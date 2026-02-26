import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { InboundMessage, ChannelAuthConfig } from './types.js'

export interface AuthResult {
  allowed: boolean
  userId?: string
  reason?: string
  paired?: boolean
}

export class AuthGuard {
  private config: ChannelAuthConfig
  private daemonToken?: string
  private pairedUsers = new Set<string>()
  private pairingCodes = new Map<string, number>()  // code → expiresAt (epoch ms)
  private channelId: string
  private onPair?: (channelId: string, userId: string) => void

  constructor(
    config: ChannelAuthConfig,
    channelId: string,
    options?: { daemonToken?: string; onPair?: (channelId: string, userId: string) => void },
  ) {
    this.config = config
    this.channelId = channelId
    this.daemonToken = options?.daemonToken
    this.onPair = options?.onPair
    if (config.allowedUsers) {
      for (const u of config.allowedUsers) {
        this.pairedUsers.add(u)
      }
    }
  }

  async check(msg: InboundMessage): Promise<AuthResult> {
    switch (this.config.mode) {
      case 'token': return this.checkToken(msg)
      case 'whitelist': return this.checkWhitelist(msg)
      case 'pairing': return this.checkPairing(msg)
    }
  }

  addUser(userId: string): void {
    this.pairedUsers.add(userId)
  }

  loadPairedUsers(users: string[]): void {
    for (const u of users) {
      this.pairedUsers.add(u)
    }
  }

  generatePairingCode(): string {
    this.pruneExpiredCodes()
    const code = randomBytes(4).toString('hex').substring(0, 6).toUpperCase()
    const ttl = (this.config.pairingTTL ?? 300) * 1000
    this.pairingCodes.set(code, Date.now() + ttl)
    return code
  }

  private safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  }

  private pruneExpiredCodes(): void {
    const now = Date.now()
    for (const [code, expiresAt] of this.pairingCodes) {
      if (now > expiresAt) {
        this.pairingCodes.delete(code)
      }
    }
  }

  private checkToken(msg: InboundMessage): AuthResult {
    const token = msg.metadata?.authToken as string | undefined
    if (!token) return { allowed: false, reason: 'Missing auth token' }
    if (this.daemonToken && this.safeEqual(token, this.daemonToken)) {
      return { allowed: true, userId: 'owner' }
    }
    if (this.config.tokens) {
      for (const [configToken, entry] of Object.entries(this.config.tokens)) {
        if (this.safeEqual(token, configToken)) {
          return { allowed: true, userId: entry.userId }
        }
      }
    }
    return { allowed: false, reason: 'Invalid token' }
  }

  private checkWhitelist(msg: InboundMessage): AuthResult {
    const userId = msg.metadata?.userId as string | undefined
    if (!userId) return { allowed: false, reason: 'Missing userId' }
    if (this.pairedUsers.has(userId)) {
      return { allowed: true, userId }
    }
    return { allowed: false, reason: `User ${userId} not in whitelist` }
  }

  private checkPairing(msg: InboundMessage): AuthResult {
    const userId = msg.metadata?.userId as string | undefined
    if (!userId) return { allowed: false, reason: 'Missing userId' }
    if (this.pairedUsers.has(userId)) {
      return { allowed: true, userId }
    }
    const pairMatch = msg.content.match(/^\/pair\s+(\S+)/)
    if (pairMatch) {
      const code = pairMatch[1]
      const expiresAt = this.pairingCodes.get(code)
      if (!expiresAt) {
        return { allowed: false, reason: 'Invalid pairing code' }
      }
      if (Date.now() > expiresAt) {
        this.pairingCodes.delete(code)
        return { allowed: false, reason: 'Pairing code expired' }
      }
      this.pairingCodes.delete(code)
      this.pairedUsers.add(userId)
      this.onPair?.(this.channelId, userId)
      return { allowed: true, userId, paired: true }
    }
    return { allowed: false, reason: 'Not paired. Send /pair <code> to authenticate.' }
  }
}
