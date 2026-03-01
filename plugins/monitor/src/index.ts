import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Hono } from 'hono'
import { registerMonitorRoutes } from './routes.js'
import { collectSnapshot } from './collector.js'

export function createMonitorPlugin(): DriftPlugin {
  let savedCtx: PluginContext | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let wsServer: any = null

  return {
    name: 'monitor',
    version: '1.0.0',
    requiresCapabilities: ['http.app', 'http.ws'],
    configSchema: {
      defaultInterval: { type: 'number', description: 'Default push interval (ms)', default: 5000 },
    },

    async init(ctx: PluginContext) {
      savedCtx = ctx
      const app = await ctx.call<Hono>('http.app', { pluginId: ctx.pluginId })
      wsServer = await ctx.call<any>('http.ws')
      registerMonitorRoutes(app)

      // Handle WS subscribe/unsubscribe
      wsServer.onMessage((_ws: any, data: unknown) => {
        const msg = data as { type?: string; payload?: { interval?: number } }
        if (msg.type === 'monitor.subscribe') {
          const interval = msg.payload?.interval ?? ctx.config.get<number>('defaultInterval', 5000)
          startPushing(interval)
        } else if (msg.type === 'monitor.unsubscribe') {
          stopPushing()
        }
      })

      ctx.logger.info('Monitor plugin initialized')
    },

    async start() {
      savedCtx?.logger.info('Monitor plugin started')
    },

    async stop() {
      stopPushing()
    },
  }

  async function startPushing(intervalMs: number) {
    stopPushing()
    const push = async () => {
      try {
        const snapshot = await collectSnapshot()
        wsServer?.broadcast({ type: 'monitor.snapshot', payload: snapshot })
      } catch (err) {
        savedCtx?.logger.error(`Monitor snapshot failed: ${err}`)
      }
    }
    await push()
    timer = setInterval(push, intervalMs)
  }

  function stopPushing() {
    if (timer) { clearInterval(timer); timer = null }
  }
}

export default createMonitorPlugin
