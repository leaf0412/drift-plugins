import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import { ChannelRouter } from './router.js'
import { HookPipeline } from './hooks.js'
import type { InboundMessage, OutboundMessage } from './types.js'
import { registerPairingRoutes } from './pairing-routes.js'

// ── Module-level registry ────────────────────────────────────
// Keyed by pluginId; used for synchronous getChannelRouter/getChannelHooks access.
const _routerRegistry = new Map<string, ChannelRouter>()
const _hooksRegistry = new Map<string, HookPipeline>()

// ── Plugin Factory ────────────────────────────────────────────

export function createChannelPlugin(): DriftPlugin {
  let router: ChannelRouter
  let hooks: HookPipeline

  return {
    name: 'channel',
    requiresCapabilities: ['sqlite.db', 'http.app'],
    capabilities: {
      'channel.router': () => router,
      'channel.hooks': () => hooks,
    },

    async init(ctx: PluginContext) {
      router = new ChannelRouter()
      _routerRegistry.set(ctx.pluginId, router)

      hooks = new HookPipeline()
      _hooksRegistry.set(ctx.pluginId, hooks)

      // Register pairing API routes
      await registerPairingRoutes(ctx)

      ctx.logger.info('Channel plugin initialized')
    },

    stop() {
      // Clean up module registry on stop (supports hot-reload)
      for (const key of Array.from(_routerRegistry.keys())) {
        _routerRegistry.delete(key)
      }
      for (const key of Array.from(_hooksRegistry.keys())) {
        _hooksRegistry.delete(key)
      }
    },
  }
}

// ── Accessors ──────────────────────────────────────────────────

/**
 * Get the ChannelRouter from context.
 * Uses module-level registry for synchronous access by dependent plugins
 * (cli-channel, web-channel).
 */
export function getChannelRouter(ctx: PluginContext): ChannelRouter {
  if (ctx.pluginId) {
    const regRouter = _routerRegistry.get(ctx.pluginId)
    if (regRouter) return regRouter
  }
  // Fall back to first registered router (covers cross-plugin access)
  if (_routerRegistry.size > 0) {
    const firstRouter = _routerRegistry.values().next().value
    if (firstRouter) return firstRouter
  }

  throw new Error('Channel plugin not initialized')
}

/**
 * Get the HookPipeline from context. Synchronous via module-level registry.
 */
export function getChannelHooks(ctx: PluginContext): HookPipeline | null {
  if (ctx.pluginId) {
    return _hooksRegistry.get(ctx.pluginId) ?? null
  }
  if (_hooksRegistry.size > 0) {
    return _hooksRegistry.values().next().value ?? null
  }

  return null
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

export default createChannelPlugin

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
