import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { SystemSnapshot } from './types.js'

const EXEC_OPTS = { timeout: 5000, encoding: 'utf-8' as const }
const IS_LINUX = process.platform === 'linux'

// ── CPU ──────────────────────────────────────────────────

/**
 * Sample CPU usage by comparing two snapshots 100ms apart.
 * Returns overall usage and per-core percentages.
 */
async function collectCpu(): Promise<SystemSnapshot['cpu']> {
  const cpus = os.cpus()
  const model = cpus[0]?.model ?? 'Unknown'
  const cores = cpus.length

  // Take two samples to calculate usage
  const sample1 = os.cpus()
  await new Promise((r) => setTimeout(r, 100))
  const sample2 = os.cpus()

  const perCore: number[] = []
  let totalIdle = 0
  let totalTick = 0

  for (let i = 0; i < sample2.length; i++) {
    const c1 = sample1[i]
    const c2 = sample2[i]
    if (!c1 || !c2) continue

    const idle1 = c1.times.idle
    const idle2 = c2.times.idle
    const total1 = c1.times.user + c1.times.nice + c1.times.sys + c1.times.idle + c1.times.irq
    const total2 = c2.times.user + c2.times.nice + c2.times.sys + c2.times.idle + c2.times.irq

    const idleDiff = idle2 - idle1
    const totalDiff = total2 - total1

    const coreUsage = totalDiff === 0 ? 0 : Math.round(((totalDiff - idleDiff) / totalDiff) * 100)
    perCore.push(Math.max(0, Math.min(100, coreUsage)))
    totalIdle += idleDiff
    totalTick += totalDiff
  }

  const usage = totalTick === 0 ? 0 : Math.round(((totalTick - totalIdle) / totalTick) * 100)

  return {
    model,
    cores,
    usage: Math.max(0, Math.min(100, usage)),
    perCore,
    loadAvg: os.loadavg() as [number, number, number],
  }
}

// ── Memory ───────────────────────────────────────────────

function collectMemory(): SystemSnapshot['memory'] {
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free

  let swapTotal = 0
  let swapUsed = 0

  if (IS_LINUX) {
    try {
      const output = execFileSync('free', ['-b'], EXEC_OPTS)
      const lines = output.trim().split('\n')
      for (const line of lines) {
        if (line.toLowerCase().startsWith('swap:')) {
          const parts = line.trim().split(/\s+/)
          swapTotal = parseInt(parts[1] ?? '0', 10) || 0
          swapUsed = parseInt(parts[2] ?? '0', 10) || 0
          break
        }
      }
    } catch {
      // swap info unavailable
    }
  } else {
    // macOS: try sysctl
    try {
      const output = execFileSync('sysctl', ['vm.swapusage'], EXEC_OPTS)
      // "vm.swapusage: total = 2048.00M  used = 123.45M  free = 1924.55M"
      const totalMatch = output.match(/total\s*=\s*([\d.]+)M/)
      const usedMatch = output.match(/used\s*=\s*([\d.]+)M/)
      if (totalMatch) swapTotal = Math.round(parseFloat(totalMatch[1]) * 1024 * 1024)
      if (usedMatch) swapUsed = Math.round(parseFloat(usedMatch[1]) * 1024 * 1024)
    } catch {
      // swap info unavailable
    }
  }

  return { total, used, free, swapTotal, swapUsed }
}

// ── Disk ─────────────────────────────────────────────────

function collectDisk(): SystemSnapshot['disk'] {
  const partitions: SystemSnapshot['disk']['partitions'] = []

  try {
    if (IS_LINUX) {
      // GNU df with --output
      const output = execFileSync('df', ['-B1', '--output=target,fstype,size,used'], EXEC_OPTS)
      const lines = output.trim().split('\n').slice(1) // skip header
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 4) continue
        const used = parseInt(parts[parts.length - 1], 10)
        const size = parseInt(parts[parts.length - 2], 10)
        const fs = parts[parts.length - 3]
        const mount = parts.slice(0, parts.length - 3).join(' ')
        // Skip pseudo filesystems
        if (fs === 'tmpfs' || fs === 'devtmpfs' || fs === 'squashfs' || fs === 'overlay') continue
        if (size === 0) continue
        partitions.push({ mount, total: size, used, fs })
      }
    } else {
      // macOS: df -b (512-byte blocks)
      const output = execFileSync('df', ['-b'], EXEC_OPTS)
      const lines = output.trim().split('\n').slice(1)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        // Filesystem 512-blocks Used Available Capacity iused ifree %iused Mounted on
        if (parts.length < 9) continue
        const mount = parts.slice(8).join(' ')
        const totalBlocks = parseInt(parts[1], 10)
        const usedBlocks = parseInt(parts[2], 10)
        const fs = parts[0].startsWith('/dev/') ? 'apfs' : parts[0]
        // Skip pseudo filesystems
        if (mount.startsWith('/System/Volumes/') && mount !== '/System/Volumes/Data') continue
        if (fs === 'devfs' || fs === 'map') continue
        if (totalBlocks === 0) continue
        partitions.push({
          mount,
          total: totalBlocks * 512,
          used: usedBlocks * 512,
          fs,
        })
      }
    }
  } catch {
    // disk info unavailable
  }

  return { partitions }
}

// ── GPU ──────────────────────────────────────────────────

function collectGpu(): SystemSnapshot['gpu'] {
  try {
    const output = execFileSync('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,fan.speed',
      '--format=csv,noheader,nounits',
    ], EXEC_OPTS)

    const gpus: SystemSnapshot['gpu'] = []
    const lines = output.trim().split('\n')

    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim())
      if (parts.length < 7) continue

      gpus.push({
        name: parts[0],
        memoryTotal: parseFloat(parts[1]) || 0,
        memoryUsed: parseFloat(parts[2]) || 0,
        utilization: parseFloat(parts[3]) || 0,
        temperature: parseFloat(parts[4]) || 0,
        powerDraw: parseFloat(parts[5]) || 0,
        fanSpeed: parseFloat(parts[6]) || 0,
      })
    }

    return gpus
  } catch {
    return []
  }
}

// ── Network ──────────────────────────────────────────────

function collectNetwork(): SystemSnapshot['network'] {
  const interfaces: SystemSnapshot['network']['interfaces'] = []

  if (IS_LINUX) {
    // Parse /proc/net/dev for byte counters
    try {
      const content = readFileSync('/proc/net/dev', 'utf-8')
      const lines = content.trim().split('\n').slice(2) // skip 2 header lines
      for (const line of lines) {
        const match = line.match(/^\s*(\S+):\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/)
        if (!match) continue
        const name = match[1]
        if (name === 'lo') continue
        const rxBytes = parseInt(match[2], 10)
        const txBytes = parseInt(match[3], 10)

        // Get IP from os.networkInterfaces()
        const osIfaces = os.networkInterfaces()
        const iface = osIfaces[name]
        const ipv4 = iface?.find((a) => a.family === 'IPv4')
        interfaces.push({
          name,
          ip: ipv4?.address ?? '',
          rxBytes,
          txBytes,
        })
      }
    } catch {
      // Fall back to os.networkInterfaces()
      collectNetworkFallback(interfaces)
    }
  } else {
    // macOS: use os.networkInterfaces() for basic info
    collectNetworkFallback(interfaces)

    // Try netstat for byte counters on macOS
    try {
      const output = execFileSync('netstat', ['-ibn'], EXEC_OPTS)
      const lines = output.trim().split('\n').slice(1)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length < 10) continue
        const name = parts[0]
        // Find matching interface
        const iface = interfaces.find((i) => i.name === name)
        if (iface) {
          // netstat -ibn: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
          iface.rxBytes = parseInt(parts[6], 10) || 0
          iface.txBytes = parseInt(parts[9], 10) || 0
        }
      }
    } catch {
      // byte counters unavailable
    }
  }

  // Connection count
  let connections = 0
  try {
    if (IS_LINUX) {
      const output = execFileSync('ss', ['-t', '-H'], EXEC_OPTS)
      connections = output.trim().split('\n').filter((l) => l.length > 0).length
    } else {
      const output = execFileSync('netstat', ['-an'], EXEC_OPTS)
      connections = output.trim().split('\n').filter((l) => l.includes('ESTABLISHED')).length
    }
  } catch {
    // connection count unavailable
  }

  return { interfaces, connections }
}

function collectNetworkFallback(interfaces: SystemSnapshot['network']['interfaces']): void {
  const osIfaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(osIfaces)) {
    if (!addrs || name === 'lo' || name === 'lo0') continue
    const ipv4 = addrs.find((a) => a.family === 'IPv4' && !a.internal)
    if (!ipv4) continue
    interfaces.push({
      name,
      ip: ipv4.address,
      rxBytes: 0,
      txBytes: 0,
    })
  }
}

// ── Processes ────────────────────────────────────────────

function collectProcesses(): SystemSnapshot['processes'] {
  let total = 0
  const top: SystemSnapshot['processes']['top'] = []

  try {
    let output: string
    if (IS_LINUX) {
      output = execFileSync('ps', ['aux', '--sort=-pcpu', '--no-headers'], EXEC_OPTS)
    } else {
      // macOS: ps aux doesn't support --no-headers or --sort
      output = execFileSync('ps', ['aux'], EXEC_OPTS)
      // Remove header line
      const lines = output.trim().split('\n')
      if (lines.length > 0) lines.shift()
      output = lines.join('\n')
    }

    const lines = output.trim().split('\n').filter((l) => l.length > 0)
    total = lines.length

    // Parse top 10 by CPU
    // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    const parsed = lines.map((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 11) return null
      return {
        pid: parseInt(parts[1], 10),
        name: parts[10].split('/').pop() ?? parts[10],
        cpu: parseFloat(parts[2]) || 0,
        memory: parseFloat(parts[3]) || 0,
      }
    }).filter((p): p is NonNullable<typeof p> => p !== null)

    // Sort by CPU desc (macOS ps doesn't sort)
    parsed.sort((a, b) => b.cpu - a.cpu)

    top.push(...parsed.slice(0, 10))
  } catch {
    // process info unavailable
  }

  return { total, top }
}

// ── Daemon ───────────────────────────────────────────────

function collectDaemon(): SystemSnapshot['daemon'] {
  const mem = process.memoryUsage()
  return {
    pid: process.pid,
    uptime: Math.round(process.uptime() * 1000), // ms
    memoryRSS: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
  }
}

// ── Master Collector ─────────────────────────────────────

/**
 * Collect a full system snapshot.
 * Each section is independently try/caught — failure of one
 * doesn't affect others. CPU collection is async (100ms sample window).
 */
export async function collectSnapshot(): Promise<SystemSnapshot> {
  const cpu = await collectCpu()

  return {
    timestamp: new Date().toISOString(),
    cpu,
    memory: collectMemory(),
    disk: collectDisk(),
    gpu: collectGpu(),
    network: collectNetwork(),
    processes: collectProcesses(),
    daemon: collectDaemon(),
  }
}
