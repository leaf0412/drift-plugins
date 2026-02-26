import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { ChannelRouter } from './router.js'
import { HookPipeline } from './hooks.js'
import type { InboundMessage, OutboundMessage } from './types.js'
import { registerPairingRoutes } from './pairing-routes.js'

// ── Plugin Manifest ──────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'channel',
  version: '1.0.0',
  type: 'code',
  capabilities: {
    events: { emit: ['channel.message_received', 'channel.message_sent'] },
    routes: ['/api/channels/*'],
  },
  depends: ['http', 'storage'],
}

// ── Plugin Factory ────────────────────────────────────────────

export function createChannelPlugin(): DriftPlugin {
  return {
    manifest,

    async init(ctx: PluginContext) {
      const router = new ChannelRouter()
      ctx.atoms.atom<ChannelRouter | null>('channel.router', null).reset(router)

      // Initialize hook pipeline if not already set (tests may pre-set it)
      const existingHooks = ctx.atoms.atom<HookPipeline | null>('channel.hooks', null).deref()
      if (!existingHooks) {
        ctx.atoms.atom<HookPipeline | null>('channel.hooks', null).reset(new HookPipeline())
      }

      // Register pairing API routes
      registerPairingRoutes(ctx)

      ctx.logger.info('Channel plugin initialized')
    },
  }
}

// ── Accessors ──────────────────────────────────────────────────

export function getChannelRouter(ctx: PluginContext): ChannelRouter {
  const router = ctx.atoms.atom<ChannelRouter | null>('channel.router', null).deref()
  if (!router) throw new Error('Channel plugin not initialized')
  return router
}

export function getChannelHooks(ctx: PluginContext): HookPipeline | null {
  return ctx.atoms.atom<HookPipeline | null>('channel.hooks', null).deref()
}

// ── processInbound ────────────────────────────────────────────

/**
 * Full message processing pipeline:
 * 1. Fire hook: message_received  (void, observational)
 * 2. Fire hook: message_sending   (modifying — can override content or cancel)
 * 3. If not cancelled, route reply through ChannelRouter.dispatch()
 * 4. Fire hook: message_sent      (void, result: success | failure)
 *
 * This function is intentionally exported as a standalone helper so that
 * channels (WebChannel, FeishuChannel, CliChannel) can call it after they
 * assemble a reply, without needing to duplicate hook logic.
 */
export async function processInbound(
  ctx: PluginContext,
  msg: InboundMessage,
  reply: OutboundMessage,
): Promise<void> {
  const hooks = getChannelHooks(ctx)
  const router = getChannelRouter(ctx)
  const hookMsgCtx = {
    channelId: msg.channelId,
    conversationId: msg.sessionId,
  }

  // 1. message_received (void)
  if (hooks) {
    await hooks.fire(
      'message_received',
      { from: msg.channelId, content: msg.content, metadata: msg.metadata },
      hookMsgCtx,
    )
  }

  // 2. message_sending (modifying)
  let effectiveContent = reply.content
  let cancelled = false

  if (hooks) {
    const result = await hooks.run(
      'message_sending',
      { to: msg.channelId, content: reply.content, metadata: reply.metadata },
      hookMsgCtx,
    )
    if (result?.cancel) {
      cancelled = true
    } else if (result?.content !== undefined) {
      effectiveContent = result.content as string
    }
  }

  if (cancelled) return

  const effectiveReply: OutboundMessage = { ...reply, content: effectiveContent }

  // 3. Dispatch through router
  let sendError: string | undefined
  try {
    await router.dispatch(msg, effectiveReply)
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err)
  }

  // 4. message_sent (void)
  if (hooks) {
    await hooks.fire(
      'message_sent',
      {
        to: msg.channelId,
        content: effectiveContent,
        success: !sendError,
        error: sendError,
      },
      hookMsgCtx,
    )
  }
}

// ── Re-exports ────────────────────────────────────────────────

export { ChannelRouter } from './router.js'
export { HookPipeline } from './hooks.js'
export type { HookRegistration } from './hooks.js'
export type {
  DriftChannel,
  MessagingAdapter,
  StreamingAdapter,
  OutboundAdapter,
  ChannelMeta,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  ChatEvent,
  ChatHandler,
  TokenUsage,
} from './types.js'
export { AuthGuard, type AuthResult } from './auth.js'
export { resolveSessionId, resolveSessionKey, sessionNamespace } from './session-resolve.js'
export { resolveAgentConfig, type IntentClassifier } from './agent-route.js'
export { resolveChannelConfig, type ResolvedChannelConfig } from './config-merge.js'
export { registerPairingRoutes } from './pairing-routes.js'
export type { SessionKey, AuthMode, ChannelAuthConfig, AgentProfile, AgentRouteConfig, ChannelConfig } from './types.js'
export { createWebChannel } from './web-channel.js'
export type { WebChannelOptions, WebChannelInstance } from './web-channel.js'
