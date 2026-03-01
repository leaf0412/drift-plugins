import type { Hono } from 'hono'
import { collectSnapshot } from './collector.js'

export function registerMonitorRoutes(app: Hono): void {
  app.get('/api/monitor/snapshot', async (c) => {
    const snapshot = await collectSnapshot()
    return c.json(snapshot)
  })
}
