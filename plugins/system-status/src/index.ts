import type { DriftPlugin, PluginManifest, PluginContext } from '@drift/core'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import cron from 'node-cron'
import { collectStatus } from './collectors.js'
import { formatMarkdown, formatFeishuCard } from './formatter.js'
import type { SystemStatusConfig } from './types.js'

// ── Manifest ──────────────────────────────────────────────

const manifest: PluginManifest = {
  name: 'system-status',
  version: '1.0.0',
  type: 'code',
  depends: [],
}

// ── Config Loader ────────────────────────────────────────

/**
 * Read config from $DRIFT_DATA_DIR/config.json -> plugins.systemStatus
 */
function loadConfig(): SystemStatusConfig {
  const dataDir = process.env.DRIFT_DATA_DIR || join(process.env.HOME || '/tmp', '.drift')
  const configPath = join(dataDir, 'config.json')
  const defaults: SystemStatusConfig = {
    interval: '*/30 * * * *',
    diskPaths: { '/': '系统盘' },
  }

  if (!existsSync(configPath)) return defaults

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const cfg = raw?.plugins?.systemStatus
    if (!cfg) return defaults
    return {
      interval: cfg.interval || defaults.interval,
      claudeOauthToken: cfg.claudeOauthToken || process.env.CLAUDE_OAUTH_TOKEN,
      diskPaths: cfg.diskPaths || defaults.diskPaths,
      daemonPort: cfg.daemonPort,
      daemonAuthToken: cfg.daemonAuthToken || process.env.DRIFT_AUTH_TOKEN,
    }
  } catch {
    return defaults
  }
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the system-status plugin.
 *
 * Collects system metrics (CPU, memory, disk, GPU, Docker, Claude usage,
 * Drift status) on a cron schedule and pushes a formatted report to all
 * registered channels via the Channel Protocol.
 */
export function createSystemStatusPlugin(): DriftPlugin {
  let task: cron.ScheduledTask | null = null
  let savedCtx: PluginContext | null = null
  let config: SystemStatusConfig

  return {
    manifest,

    async init(ctx: PluginContext) {
      savedCtx = ctx
      config = loadConfig()
      ctx.logger.info('System status plugin initialized')
    },

    async start() {
      const ctx = savedCtx!

      const run = async () => {
        try {
          const report = await collectStatus(config)
          const markdown = formatMarkdown(report)
          const card = formatFeishuCard(report)

          const channels = ctx.channels.list()
          ctx.logger.info(`System status: pushing to ${channels.length} channel(s)`)
          for (const ch of channels) {
            try {
              await ch.send({
                type: 'card',
                content: markdown,
                metadata: { event: 'system.status', card },
              })
            } catch (err) {
              ctx.logger.warn(`System status: failed to send to ${ch.name}: ${err}`)
            }
          }
        } catch (err) {
          ctx.logger.error(`System status: collection failed: ${err}`)
        }
      }

      // Delay initial run to let all plugins (channels) finish starting
      setTimeout(run, 5000)
      task = cron.schedule(config.interval, run)

      ctx.logger.info(`System status: scheduled at "${config.interval}"`)
    },

    async stop() {
      if (task) {
        task.stop()
        task = null
      }
    },
  }
}

export default createSystemStatusPlugin
