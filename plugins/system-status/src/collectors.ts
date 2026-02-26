import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SystemMetrics,
  GpuMetrics,
  DockerContainer,
  ClaudeUsage,
  DriftStatus,
  StatusReport,
  SystemStatusConfig,
} from './types.js'

// ── System ──────────────────────────────────────────────

/**
 * Collect CPU load, memory usage, and disk space for configured mount points.
 *
 * Uses `df -BG --output=target,avail` to parse available disk space.
 * On macOS, falls back to `df -g` since GNU coreutils flags are unavailable.
 */
export function collectSystem(diskPaths: Record<string, string>): SystemMetrics {
  const load = os.loadavg() as [number, number, number]
  const freeMemoryMB = Math.round(os.freemem() / 1024 / 1024)
  const totalMemoryMB = Math.round(os.totalmem() / 1024 / 1024)

  const disks = parseDiskInfo(diskPaths)

  return {
    cpuLoad: load,
    freeMemoryMB,
    totalMemoryMB,
    disks,
  }
}

function parseDiskInfo(diskPaths: Record<string, string>): SystemMetrics['disks'] {
  const mounts = Object.keys(diskPaths)
  if (mounts.length === 0) return []

  try {
    // Try GNU df first (Linux)
    const output = execFileSync('df', ['-BG', '--output=target,avail'], {
      timeout: 5000,
      encoding: 'utf-8',
    })
    return parseDfGnu(output, diskPaths)
  } catch {
    try {
      // Fallback: macOS df -g (1G blocks)
      const output = execFileSync('df', ['-g'], {
        timeout: 5000,
        encoding: 'utf-8',
      })
      return parseDfBsd(output, diskPaths)
    } catch {
      return []
    }
  }
}

/**
 * Parse GNU df output:
 *   Mounted on     Avail
 *   /              123G
 */
function parseDfGnu(output: string, diskPaths: Record<string, string>): SystemMetrics['disks'] {
  const lines = output.trim().split('\n').slice(1) // skip header
  const disks: SystemMetrics['disks'] = []

  for (const line of lines) {
    // Output format: "target  availG" — last token is avail, rest is mount
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const availStr = parts[parts.length - 1]
    const mount = parts.slice(0, parts.length - 1).join(' ')
    if (!(mount in diskPaths)) continue
    const availGB = parseInt(availStr.replace(/G$/i, ''), 10)
    if (isNaN(availGB)) continue
    disks.push({ mount, label: diskPaths[mount], availGB })
  }

  return disks
}

/**
 * Parse BSD (macOS) df -g output:
 *   Filesystem  1G-blocks  Used  Available  Capacity  Mounted on
 *   /dev/disk1  233        180   53         78%       /
 */
function parseDfBsd(output: string, diskPaths: Record<string, string>): SystemMetrics['disks'] {
  const lines = output.trim().split('\n').slice(1) // skip header
  const disks: SystemMetrics['disks'] = []

  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    // BSD format: filesystem, total, used, avail, capacity%, mounted on
    if (parts.length < 6) continue
    const mount = parts.slice(5).join(' ')
    if (!(mount in diskPaths)) continue
    const availGB = parseInt(parts[3], 10)
    if (isNaN(availGB)) continue
    disks.push({ mount, label: diskPaths[mount], availGB })
  }

  return disks
}

// ── GPU ─────────────────────────────────────────────────

/**
 * Collect NVIDIA GPU metrics via nvidia-smi.
 * Returns null if nvidia-smi is not available.
 */
export function collectGpu(): GpuMetrics | null {
  try {
    const output = execFileSync('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], {
      timeout: 5000,
      encoding: 'utf-8',
    })

    const parts = output.trim().split(',').map((s) => s.trim())
    if (parts.length < 4) return null

    const utilization = parseFloat(parts[0])
    const memoryUsedMiB = parseFloat(parts[1])
    const memoryTotalMiB = parseFloat(parts[2])
    const temperatureC = parseFloat(parts[3])

    if ([utilization, memoryUsedMiB, memoryTotalMiB, temperatureC].some(isNaN)) return null

    return {
      utilization,
      memoryUsedGB: Math.round((memoryUsedMiB / 1024) * 100) / 100,
      memoryTotalGB: Math.round((memoryTotalMiB / 1024) * 100) / 100,
      temperatureC,
    }
  } catch {
    return null
  }
}

// ── Docker ──────────────────────────────────────────────

/**
 * List running Docker containers.
 * Returns null if docker is not available.
 */
export function collectDocker(): DockerContainer[] | null {
  try {
    const output = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Status}}'], {
      timeout: 5000,
      encoding: 'utf-8',
    })

    const lines = output.trim().split('\n').filter((l) => l.length > 0)
    return lines.map((line) => {
      const [name, ...statusParts] = line.split('\t')
      return { name: name.trim(), status: statusParts.join('\t').trim() }
    })
  } catch {
    return null
  }
}

// ── Claude Usage ────────────────────────────────────────

/**
 * Resolve OAuth token: explicit config > Claude Code credentials file.
 */
function resolveOAuthToken(configToken?: string): string | null {
  if (configToken) return configToken

  // Read from Claude Code's credential file (~/.claude/.credentials.json)
  const credPath = join(process.env.HOME || '/root', '.claude', '.credentials.json')
  if (!existsSync(credPath)) return null

  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'))
    const oauth = creds?.claudeAiOauth
    if (!oauth?.accessToken) return null
    // Check token expiry
    if (oauth.expiresAt && oauth.expiresAt <= Date.now()) return null
    return oauth.accessToken
  } catch {
    return null
  }
}

/**
 * Fetch Claude API usage from the OAuth endpoint.
 * Auto-discovers token from Claude Code credentials if not explicitly configured.
 */
export async function collectClaude(oauthToken?: string): Promise<ClaudeUsage | null> {
  const token = resolveOAuthToken(oauthToken)
  if (!token) return null

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    })

    clearTimeout(timeout)
    if (!res.ok) return null

    const data = await res.json() as {
      seven_day?: { utilization?: number; resets_at?: string }
      five_hour?: { utilization?: number; resets_at?: string }
    }

    const sevenDay = data.seven_day ?? {}
    const fiveHour = data.five_hour ?? {}

    // Calculate cycle day: reset is 7 days after cycle start
    let cycleDayNum = 1
    const cycleDayTotal = 7
    if (sevenDay.resets_at) {
      const resetDate = new Date(sevenDay.resets_at)
      const cycleStart = new Date(resetDate.getTime() - 7 * 24 * 60 * 60 * 1000)
      const now = new Date()
      const elapsed = now.getTime() - cycleStart.getTime()
      cycleDayNum = Math.max(1, Math.min(7, Math.ceil(elapsed / (24 * 60 * 60 * 1000))))
    }

    return {
      sevenDay: {
        utilization: sevenDay.utilization ?? 0,
        resetsAt: sevenDay.resets_at ?? null,
      },
      fiveHour: {
        utilization: fiveHour.utilization ?? 0,
        resetsAt: fiveHour.resets_at ?? null,
      },
      cycleDayNum,
      cycleDayTotal,
    }
  } catch {
    return null
  }
}

// ── Drift Status ────────────────────────────────────────

/**
 * Fetch Drift daemon status and agent count.
 * Returns null if daemon is unreachable.
 */
export async function collectDrift(port?: number, authToken?: string): Promise<DriftStatus | null> {
  const baseUrl = `http://localhost:${port ?? 3141}`
  const headers: Record<string, string> = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : {}

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)

    const [statusRes, agentsRes] = await Promise.all([
      fetch(`${baseUrl}/api/status`, { signal: controller.signal }),
      fetch(`${baseUrl}/api/agents`, { headers, signal: controller.signal }),
    ])

    clearTimeout(timeout)

    let uptimeSeconds = 0
    if (statusRes.ok) {
      const statusData = await statusRes.json() as { uptime?: number }
      uptimeSeconds = statusData.uptime ?? 0
    }

    let agentCount = 0
    if (agentsRes.ok) {
      const agentsData = await agentsRes.json() as unknown[]
      agentCount = Array.isArray(agentsData) ? agentsData.length : 0
    }

    return { uptimeSeconds, agentCount }
  } catch {
    return null
  }
}

// ── Master Collector ────────────────────────────────────

/**
 * Collect all system metrics. Each collector is independently try/caught —
 * failure of one doesn't affect others.
 */
export async function collectStatus(config: SystemStatusConfig): Promise<StatusReport> {
  // Sync collectors
  let system: SystemMetrics | null = null
  let gpu: GpuMetrics | null = null
  let docker: DockerContainer[] | null = null

  try {
    system = collectSystem(config.diskPaths)
  } catch {
    system = null
  }

  try {
    gpu = collectGpu()
  } catch {
    gpu = null
  }

  try {
    docker = collectDocker()
  } catch {
    docker = null
  }

  // Async collectors in parallel
  const [claude, drift] = await Promise.all([
    collectClaude(config.claudeOauthToken).catch(() => null),
    collectDrift(config.daemonPort, config.daemonAuthToken).catch(() => null),
  ])

  return {
    system,
    gpu,
    docker,
    claude,
    drift,
    timestamp: new Date().toISOString(),
  }
}
