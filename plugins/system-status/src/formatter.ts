import type { StatusReport } from './types.js'

// ── Helpers ─────────────────────────────────────────────

/**
 * Format seconds into a human-readable uptime string.
 * e.g. 90000 => "1d 1h 0m", 0 => "0m"
 */
export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '0m'

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)

  return parts.join(' ')
}

/**
 * Format timestamp in Asia/Shanghai timezone.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

// ── Markdown Formatter ──────────────────────────────────

/**
 * Format a StatusReport as universal markdown text.
 * Used as content fallback for non-card channels.
 */
export function formatMarkdown(report: StatusReport): string {
  const sections: string[] = []

  // System
  if (report.system) {
    const { cpuLoad, freeMemoryMB, totalMemoryMB, disks } = report.system
    const lines = [
      '**System**',
      `- CPU Load: ${cpuLoad[0].toFixed(2)} / ${cpuLoad[1].toFixed(2)} / ${cpuLoad[2].toFixed(2)}`,
      `- Memory: ${freeMemoryMB} MB free / ${totalMemoryMB} MB total`,
    ]
    for (const disk of disks) {
      lines.push(`- ${disk.label} (${disk.mount}): ${disk.availGB} GB available`)
    }
    sections.push(lines.join('\n'))
  }

  // GPU
  if (report.gpu) {
    const { utilization, memoryUsedGB, memoryTotalGB, temperatureC } = report.gpu
    sections.push([
      '**GPU**',
      `- Utilization: ${utilization}%`,
      `- Memory: ${memoryUsedGB} / ${memoryTotalGB} GB`,
      `- Temperature: ${temperatureC}C`,
    ].join('\n'))
  }

  // Docker
  if (report.docker) {
    const lines = ['**Docker**']
    for (const c of report.docker) {
      const icon = c.status.toLowerCase().startsWith('up') ? '\u2705' : '\u274C'
      lines.push(`- ${icon} ${c.name}: ${c.status}`)
    }
    sections.push(lines.join('\n'))
  }

  // Claude
  if (report.claude) {
    const { subscriptionType, sevenDay, fiveHour, sevenDaySonnet, sevenDayOpus, cycleDayNum, cycleDayTotal } = report.claude
    const planLabel = subscriptionType ? ` (${subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)})` : ''
    const lines = [
      `**Claude${planLabel}**`,
      `- \u5168\u6A21\u578B\u5468\u9650\u989D: ${Math.round(sevenDay.utilization)}%`,
      `- 5h \u7A97\u53E3: ${Math.round(fiveHour.utilization)}%`,
    ]
    if (sevenDaySonnet) lines.push(`- Sonnet \u5468\u9650\u989D: ${Math.round(sevenDaySonnet.utilization)}%`)
    if (sevenDayOpus) lines.push(`- Opus \u5468\u9650\u989D: ${Math.round(sevenDayOpus.utilization)}%`)
    lines.push(`- \u5468\u671F\u7B2C${cycleDayNum}\u5929 (\u5171${cycleDayTotal}\u5929)`)
    sections.push(lines.join('\n'))
  }

  // Drift
  if (report.drift) {
    const { uptimeSeconds, agentCount } = report.drift
    sections.push([
      '**Drift**',
      `- Uptime: ${formatUptime(uptimeSeconds)}`,
      `- Agents: ${agentCount}`,
    ].join('\n'))
  }

  const ts = formatTimestamp(report.timestamp)
  sections.push(`_${ts}_`)

  return sections.join('\n\n')
}

// ── Feishu Card Formatter ───────────────────────────────

/**
 * Build a Feishu interactive card for the status report.
 *
 * The card structure is:
 *   header → [section, hr, ...]* → note (timestamp)
 *
 * Feishu channel checks `msg.type === 'card' && msg.metadata?.card`,
 * then sends the card object directly via webhook.
 */
export function formatFeishuCard(report: StatusReport): {
  msg_type: 'interactive'
  card: { header: Record<string, unknown>; elements: Record<string, unknown>[] }
} {
  const elements: Record<string, unknown>[] = []

  // System section
  if (report.system) {
    const { cpuLoad, freeMemoryMB, totalMemoryMB, disks } = report.system
    let content = `**\uD83D\uDCBB \u7CFB\u7EDF**\n`
    content += `CPU Load: ${cpuLoad[0].toFixed(2)} / ${cpuLoad[1].toFixed(2)} / ${cpuLoad[2].toFixed(2)}\n`
    content += `Memory: ${freeMemoryMB} MB free / ${totalMemoryMB} MB total`
    for (const disk of disks) {
      content += `\n${disk.label} (${disk.mount}): ${disk.availGB} GB available`
    }
    elements.push({ tag: 'markdown', content })
    elements.push({ tag: 'hr' })
  }

  // GPU section
  if (report.gpu) {
    const { utilization, memoryUsedGB, memoryTotalGB, temperatureC } = report.gpu
    const content = [
      `**\uD83C\uDFAE GPU**`,
      `Utilization: ${utilization}%`,
      `Memory: ${memoryUsedGB} / ${memoryTotalGB} GB`,
      `Temperature: ${temperatureC}\u00B0C`,
    ].join('\n')
    elements.push({ tag: 'markdown', content })
    elements.push({ tag: 'hr' })
  }

  // Docker section
  if (report.docker) {
    let content = `**\uD83D\uDC33 Docker**\n`
    for (const c of report.docker) {
      const icon = c.status.toLowerCase().startsWith('up') ? '\u2705' : '\u274C'
      content += `${icon} ${c.name}: ${c.status}\n`
    }
    elements.push({ tag: 'markdown', content: content.trimEnd() })
    elements.push({ tag: 'hr' })
  }

  // Claude section
  if (report.claude) {
    const { subscriptionType, sevenDay, fiveHour, sevenDaySonnet, sevenDayOpus, cycleDayNum, cycleDayTotal } = report.claude
    const planLabel = subscriptionType ? ` (${subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1)})` : ''
    const lines = [
      `**\uD83E\uDDE0 Claude${planLabel}**`,
      `\u5168\u6A21\u578B\u5468\u9650\u989D: ${Math.round(sevenDay.utilization)}%`,
      `5h \u7A97\u53E3: ${Math.round(fiveHour.utilization)}%`,
    ]
    if (sevenDaySonnet) lines.push(`Sonnet \u5468\u9650\u989D: ${Math.round(sevenDaySonnet.utilization)}%`)
    if (sevenDayOpus) lines.push(`Opus \u5468\u9650\u989D: ${Math.round(sevenDayOpus.utilization)}%`)
    lines.push(`\u5468\u671F\u7B2C${cycleDayNum}\u5929 (\u5171${cycleDayTotal}\u5929)`)
    elements.push({ tag: 'markdown', content: lines.join('\n') })
    elements.push({ tag: 'hr' })
  }

  // Drift section
  if (report.drift) {
    const { uptimeSeconds, agentCount } = report.drift
    const content = [
      `**\u2699\uFE0F Drift**`,
      `Uptime: ${formatUptime(uptimeSeconds)}`,
      `Agents: ${agentCount}`,
    ].join('\n')
    elements.push({ tag: 'markdown', content })
    elements.push({ tag: 'hr' })
  }

  // Remove trailing hr if present
  if (elements.length > 0 && (elements[elements.length - 1] as { tag: string }).tag === 'hr') {
    elements.pop()
  }

  // Timestamp note at bottom
  const ts = formatTimestamp(report.timestamp)
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `\uD83D\uDCCA ${ts}` }],
  })

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: '\uD83C\uDFE0 Drift Agent: \u7CFB\u7EDF\u72B6\u6001\u62A5\u544A' },
        template: 'purple',
      },
      elements,
    },
  }
}
