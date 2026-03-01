// plugin-mgr/routes.ts — HTTP routes for plugin management
// Delegates all operations to PluginManager directly (old daemon doesn't support ctx.call)

import type { Hono } from 'hono'

/** PluginManager-like interface — avoids importing from @drift/core which may not have it yet */
interface PluginManagerLike {
  listPlugins(): unknown[]
  getPluginConfig(name: string): Record<string, unknown>
  setPluginConfig(name: string, data: Record<string, unknown>): Promise<void>
  enablePlugin(name: string): Promise<void>
  disablePlugin(name: string): Promise<void>
  deletePlugin(name: string): Promise<void>
  reloadPlugin(name: string): Promise<void>
  reloadAll(): Promise<{ reloaded: string[]; failed: string[] }>
}

export function registerPluginMgrRoutes(app: Hono, pm: PluginManagerLike | null): void {
  if (!pm) {
    console.warn('plugin-mgr: PluginManager not available, skipping HTTP routes')
    return
  }

  // GET /api/plugins — list all plugins
  app.get('/api/plugins', (c) => {
    const plugins = pm.listPlugins()
    return c.json(plugins)
  })

  // GET /api/plugins/:name/config — get plugin config
  app.get('/api/plugins/:name/config', (c) => {
    const name = c.req.param('name')
    const config = pm.getPluginConfig(name)
    return c.json(config)
  })

  // PUT /api/plugins/:name/config — update plugin config
  app.put('/api/plugins/:name/config', async (c) => {
    const name = c.req.param('name')
    const body = await c.req.json()
    try {
      await pm.setPluginConfig(name, body)
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: true, warning: `Config saved but reload failed: ${err?.message}` })
    }
  })

  // POST /api/plugins/:name/enable
  app.post('/api/plugins/:name/enable', async (c) => {
    const name = c.req.param('name')
    try {
      await pm.enablePlugin(name)
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })

  // POST /api/plugins/:name/disable
  app.post('/api/plugins/:name/disable', async (c) => {
    const name = c.req.param('name')
    try {
      await pm.disablePlugin(name)
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })

  // DELETE /api/plugins/:name
  app.delete('/api/plugins/:name', async (c) => {
    const name = c.req.param('name')
    try {
      await pm.deletePlugin(name)
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })

  // IMPORTANT: Static route /api/plugins/reload MUST be registered BEFORE
  // parametric /api/plugins/:name/reload to avoid Hono matching "reload" as :name

  // POST /api/plugins/reload — reload all plugins
  app.post('/api/plugins/reload', async (c) => {
    const result = await pm.reloadAll()
    return c.json(result)
  })

  // POST /api/plugins/:name/reload — reload single plugin
  app.post('/api/plugins/:name/reload', async (c) => {
    const name = c.req.param('name')
    try {
      await pm.reloadPlugin(name)
      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message }, 400)
    }
  })
}
