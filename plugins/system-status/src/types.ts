// ── System Metrics ───────────────────────────────────────

export interface SystemMetrics {
  cpuLoad: [number, number, number] // 1min, 5min, 15min
  freeMemoryMB: number
  totalMemoryMB: number
  disks: DiskInfo[]
}

export interface DiskInfo {
  mount: string
  label: string
  availGB: number
}

// ── GPU Metrics ─────────────────────────────────────────

export interface GpuMetrics {
  utilization: number
  memoryUsedGB: number
  memoryTotalGB: number
  temperatureC: number
}

// ── Docker ──────────────────────────────────────────────

export interface DockerContainer {
  name: string
  status: string
}

// ── Claude Usage ────────────────────────────────────────

export interface ClaudeUsage {
  subscriptionType: string | null  // "max", "pro", "team", etc.
  sevenDay: { utilization: number; resetsAt: string | null }
  fiveHour: { utilization: number; resetsAt: string | null }
  sevenDaySonnet: { utilization: number; resetsAt: string | null } | null
  sevenDayOpus: { utilization: number; resetsAt: string | null } | null
  cycleDayNum: number
  cycleDayTotal: number
}

// ── Drift Status ────────────────────────────────────────

export interface DriftStatus {
  uptimeSeconds: number
  agentCount: number
}

// ── Status Report ───────────────────────────────────────

export interface StatusReport {
  system: SystemMetrics | null
  gpu: GpuMetrics | null
  docker: DockerContainer[] | null
  claude: ClaudeUsage | null
  drift: DriftStatus | null
  timestamp: string
}

// ── Config ──────────────────────────────────────────────

export interface SystemStatusConfig {
  interval: string // cron expression, default "*/30 * * * *"
  claudeOauthToken?: string
  diskPaths: Record<string, string> // mount -> label, e.g. { "/": "系统盘" }
  daemonPort?: number // default 3141
  daemonAuthToken?: string
}
