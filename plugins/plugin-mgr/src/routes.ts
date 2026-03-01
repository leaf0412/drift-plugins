// plugin-mgr/routes.ts — HTTP routes for plugin management
// Delegates all operations to plugin-mgr.* capabilities via ctx.call()

import type { Hono } from 'hono'
import type { PluginContext } from '@drift/core/kernel'

export function registerPluginMgrRoutes(app: Hono, ctx: PluginContext): void {
  // GET /api/plugins — list all plugins
  app.get('/api/plugins', async (c) => {
    const plugins = await ctx.call<any[]>('plugin-mgr.list')
    return c.json(plugins)
  })

  // GET /api/plugins/:name/config — get plugin config
  app.get('/api/plugins/:name/config', async (c) => {
    const name = c.req.param('name')
    const config = await ctx.call<Record<string, unknown>>('plugin-mgr.config.get', { name })
    return c.json(config)
  })

  // PUT /api/plugins/:name/config — update plugin config
  app.put('/api/plugins/:name/config', async (c) => {
    const name = c.req.param('name')
    const body = await c.req.json()
    const result = await ctx.call<{ reloadError?: string }>('plugin-mgr.config.set', { name, ...body })
    if (result?.reloadError) {
      return c.json({ ok: true, warning: `Config saved but reload failed: ${result.reloadError}` })
    }
    return c.json({ ok: true })
  })

  // POST /api/plugins/:name/enable
  app.post('/api/plugins/:name/enable', async (c) => {
    const name = c.req.param('name')
    try {
      const result = await ctx.call<{ reloadError?: string }>('plugin-mgr.enable', { name })
      if (result?.reloadError) {
        return c.json({ ok: true, warning: result.reloadError })
      }
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })

  // POST /api/plugins/:name/disable
  app.post('/api/plugins/:name/disable', async (c) => {
    const name = c.req.param('name')
    try {
      await ctx.call('plugin-mgr.disable', { name })
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })

  // DELETE /api/plugins/:name
  app.delete('/api/plugins/:name', async (c) => {
    const name = c.req.param('name')
    try {
      await ctx.call('plugin-mgr.delete', { name })
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })

  // IMPORTANT: Static route /api/plugins/reload MUST be registered BEFORE
  // parametric /api/plugins/:name/reload to avoid Hono matching "reload" as :name

  // POST /api/plugins/reload — reload all plugins
  app.post('/api/plugins/reload', async (c) => {
    const result = await ctx.call<{ reloaded: string[]; failed: string[] }>('plugin-mgr.reload-all')
    return c.json(result)
  })

  // POST /api/plugins/:name/reload — reload single plugin
  app.post('/api/plugins/:name/reload', async (c) => {
    const name = c.req.param('name')
    try {
      const result = await ctx.call('plugin-mgr.reload', { name })
      return c.json({ ok: true, result })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })
}
