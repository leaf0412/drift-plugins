import type { DriftChannel, InboundMessage, OutboundMessage, ChatEvent, ChatHandler } from './types.js'
import type { ResolvedChannelConfig } from './config-merge.js'
import { AuthGuard } from './auth.js'
import { resolveSessionId } from './session-resolve.js'
import { resolveAgentConfig, type IntentClassifier } from './agent-route.js'

/**
 * ChannelRouter maintains a registry of DriftChannel instances and
 * dispatches InboundMessage -> OutboundMessage pairs to the correct channel.
 *
 * When a channel has a ResolvedChannelConfig, handleInbound() runs a
 * 4-step gateway pipeline: auth → session → agent → chat.
 *
 * Hook integration (message_received / message_sending / message_sent)
 * is handled by the channel plugin, not the router itself, so that the
 * router stays a pure data structure.
 */
export class ChannelRouter {
  private channels = new Map<string, DriftChannel>()
  private chatHandler?: ChatHandler
  private channelConfigs = new Map<string, ResolvedChannelConfig>()
  private authGuards = new Map<string, AuthGuard>()
  private intentClassifier?: IntentClassifier
  private daemonToken?: string
  private persistPair?: (channelId: string, userId: string) => void
  private loadPairedUsersFn?: (channelId: string) => string[]

  // ── Config ──────────────────────────────────────────────────

  setDaemonToken(token: string): void {
    this.daemonToken = token
  }

  setIntentClassifier(classifier: IntentClassifier): void {
    this.intentClassifier = classifier
  }

  setPersistence(opts: {
    onPair: (channelId: string, userId: string) => void
    loadPairedUsers: (channelId: string) => string[]
  }): void {
    this.persistPair = opts.onPair
    this.loadPairedUsersFn = opts.loadPairedUsers
  }

  setChannelConfig(channelId: string, config: ResolvedChannelConfig): void {
    this.channelConfigs.set(channelId, config)
    if (config.auth) {
      const guard = new AuthGuard(config.auth, channelId, {
        daemonToken: this.daemonToken,
        onPair: this.persistPair,
      })
      // Load existing paired users from DB
      if (this.loadPairedUsersFn) {
        guard.loadPairedUsers(this.loadPairedUsersFn(channelId))
      }
      this.authGuards.set(channelId, guard)
    } else {
      this.authGuards.delete(channelId)
    }
  }

  getChannelConfig(channelId: string): ResolvedChannelConfig | undefined {
    return this.channelConfigs.get(channelId)
  }

  getAuthGuard(channelId: string): AuthGuard | undefined {
    return this.authGuards.get(channelId)
  }

  // ── Channel registry (unchanged) ──────────────────────────

  /**
   * Register a channel. If a channel with the same id already exists,
   * it is replaced.
   */
  register(channel: DriftChannel): void {
    this.channels.set(channel.id, channel)
  }

  /**
   * Remove a channel by id. No-op if not found.
   */
  unregister(id: string): void {
    this.channels.delete(id)
  }

  /**
   * Get a channel by id. Returns undefined if not registered.
   */
  get(id: string): DriftChannel | undefined {
    return this.channels.get(id)
  }

  /**
   * List all registered channels.
   */
  list(): DriftChannel[] {
    return [...this.channels.values()]
  }

  /**
   * Dispatch an inbound message by routing the reply through the
   * matching channel's MessagingAdapter.send().
   *
   * Throws if the channel is not registered.
   */
  async dispatch(msg: InboundMessage, reply: OutboundMessage): Promise<void> {
    const channel = this.channels.get(msg.channelId)
    if (!channel) {
      throw new Error(`Channel "${msg.channelId}" not registered`)
    }
    await channel.messaging.send(reply)
  }

  // ── Chat flow ──────────────────────────────────────────────

  /** Register the chat handler (called by Chat plugin). */
  onMessage(handler: ChatHandler): void {
    this.chatHandler = handler
  }

  /** Check if a chat handler is registered. */
  hasHandler(): boolean {
    return !!this.chatHandler
  }

  /**
   * Pipe an inbound message through the 4-step gateway pipeline:
   *   1. Auth   — verify the sender (if auth config exists)
   *   2. Session — namespace the sessionId with channelId:userId
   *   3. Agent  — resolve agent profile into metadata
   *   4. Chat   — delegate to the registered ChatHandler
   *
   * If no channel config is set for the channelId, the message is
   * passed through to the ChatHandler unchanged (backward compatible).
   */
  async *handleInbound(msg: InboundMessage): AsyncGenerator<ChatEvent> {
    if (!this.chatHandler) {
      throw new Error('No chat handler registered')
    }

    const config = this.channelConfigs.get(msg.channelId)

    // No config → backward compatible pass-through
    if (!config) {
      yield* this.chatHandler(msg)
      return
    }

    // Step 1: Auth
    const guard = this.authGuards.get(msg.channelId)
    if (guard) {
      const authResult = await guard.check(msg)
      if (!authResult.allowed) {
        yield { type: 'error', sessionId: msg.sessionId || '', error: authResult.reason || 'Unauthorized' }
        return
      }
      msg = { ...msg, metadata: { ...msg.metadata, userId: authResult.userId } }
    }

    // Step 2: Session resolve
    const resolvedSessionId = resolveSessionId(msg)
    msg = { ...msg, sessionId: resolvedSessionId }

    // Step 3: Agent route
    const agentConfig = await resolveAgentConfig(
      { agent: config.agent },
      msg.content,
      this.intentClassifier,
    )
    if (agentConfig) {
      msg = { ...msg, metadata: { ...msg.metadata, agentConfig } }
    }

    // Step 4: ChatHandler
    yield* this.chatHandler(msg)
  }
}
