import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Channel } from '@drift/core'
import cron from 'node-cron'
import { collectStatus } from './collectors.js'
import { formatMarkdown, formatFeishuCard } from './formatter.js'
import type { SystemStatusConfig, StatusReport } from './types.js'

// ── Change Detection ─────────────────────────────────────

/**
 * Build a coarse fingerprint of a StatusReport for change detection.
 * Rounds noisy metrics, skips always-changing fields (uptime, timestamp).
 */
function fingerprint(r: StatusReport): string {
  const parts: string[] = []

  if (r.system) {
    const { cpuLoad, freeMemoryMB, totalMemoryMB, disks } = r.system
    // CPU rounded to integer, memory rounded to nearest 100MB
    parts.push(`cpu:${cpuLoad.map(v => Math.round(v)).join('/')}`)
    parts.push(`mem:${Math.round(freeMemoryMB / 100)}/${Math.round(totalMemoryMB / 100)}`)
    for (const d of disks) parts.push(`disk:${d.mount}:${d.availGB}`)
  }

  if (r.gpu) {
    parts.push(`gpu:${Math.round(r.gpu.utilization)}/${Math.round(r.gpu.memoryUsedGB)}/${Math.round(r.gpu.temperatureC)}`)
  }

  if (r.docker) {
    // Only care about up/down, not exact uptime text
    for (const c of r.docker) {
      const up = c.status.toLowerCase().startsWith('up') ? 'up' : 'down'
      parts.push(`docker:${c.name}:${up}`)
    }
  }

  if (r.claude) {
    parts.push(`claude:${r.claude.subscriptionType}/${Math.round(r.claude.sevenDay.utilization)}/${Math.round(r.claude.fiveHour.utilization)}`)
    if (r.claude.sevenDaySonnet) parts.push(`sonnet:${Math.round(r.claude.sevenDaySonnet.utilization)}`)
    if (r.claude.sevenDayOpus) parts.push(`opus:${Math.round(r.claude.sevenDayOpus.utilization)}`)
    parts.push(`cycle:${r.claude.cycleDayNum}`)
  }

  if (r.drift) {
    // Skip uptimeSeconds (always changes), only track agent count
    parts.push(`agents:${r.drift.agentCount}`)
  }

  return parts.join('|')
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the system-status plugin.
 *
 * Collects system metrics (CPU, memory, disk, GPU, Docker, Claude usage,
 * Drift status) on a cron schedule and pushes a formatted report to all
 * registered channels via the capability system (`channel.list`).
 */
export function createSystemStatusPlugin(): DriftPlugin {
  let task: cron.ScheduledTask | null = null
  let savedCtx: PluginContext | null = null
  let config: SystemStatusConfig
  let lastFingerprint: string | null = null

  return {
    name: 'system-status',
    version: '1.1.0',

    configSchema: {
      interval:         { type: 'string', description: 'Cron 表达式', default: '*/30 * * * *' },
      claudeOauthToken: { type: 'string', description: 'Claude OAuth Token', secret: true },
      diskPaths:        { type: 'string', description: '磁盘路径 JSON (如 {"/": "系统盘"})' },
      daemonPort:       { type: 'number', description: 'Drift daemon 端口', default: 3141 },
      daemonAuthToken:  { type: 'string', description: 'Drift daemon auth token', secret: true },
    },

    async init(ctx: PluginContext) {
      savedCtx = ctx

      const interval = ctx.config.get<string>('interval', '*/30 * * * *')
      const claudeOauthToken = ctx.config.get<string>('claudeOauthToken')
      const diskPathsRaw = ctx.config.get<string>('diskPaths', '{"/": "系统盘"}')
      const diskPaths = typeof diskPathsRaw === 'object' ? diskPathsRaw as unknown as Record<string, string> : JSON.parse(diskPathsRaw || '{}')
      const daemonPort = ctx.config.get<number>('daemonPort', 3141)
      const daemonAuthToken = ctx.config.get<string>('daemonAuthToken')

      config = { interval, claudeOauthToken, diskPaths, daemonPort, daemonAuthToken }
      ctx.logger.info('System status plugin initialized')
    },

    async start() {
      const ctx = savedCtx!

      const run = async () => {
        try {
          const report = await collectStatus(config)
          const fp = fingerprint(report)

          if (fp === lastFingerprint) {
            ctx.logger.info('System status: no changes, skipping push')
            return
          }
          lastFingerprint = fp

          const markdown = formatMarkdown(report)
          const card = formatFeishuCard(report)

          const channels = await ctx.call<Channel[]>('channel.list').catch(() => [] as Channel[])
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
