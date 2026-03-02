import type { DriftPlugin, PluginContext } from '@drift/core/kernel'
import type { Channel, ChannelCapabilities, OutgoingMessage } from '@drift/core'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ── Constants ─────────────────────────────────────────────

const MAX_BODY_CHARS = 200

// ── OS Notification ───────────────────────────────────────

/**
 * Strip markdown formatting for plain-text OS notifications.
 * Removes bold (**text**), headers (#), and collapses excess whitespace.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .trim()
}

/**
 * Send an OS native notification.
 *
 * macOS: uses `osascript` with `display notification` command.
 * Linux: uses `notify-send`.
 *
 * execFile is used instead of exec to prevent shell injection — arguments
 * are passed as separate array elements, never interpolated into a shell string.
 */
async function sendOsNotification(title: string, body: string): Promise<void> {
  const platform = process.platform
  const truncatedBody = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '…' : body

  if (platform === 'darwin') {
    // osascript -e 'display notification "body" with title "title"'
    const script = `display notification ${JSON.stringify(truncatedBody)} with title ${JSON.stringify(title)}`
    await execFileAsync('osascript', ['-e', script])
  } else if (platform === 'linux') {
    // notify-send "title" "body"
    await execFileAsync('notify-send', [title, truncatedBody])
  } else {
    throw new Error(`sys-notify: unsupported platform "${platform}" (supports: darwin, linux)`)
  }
}

// ── Plugin Factory ────────────────────────────────────────

/**
 * Create the sys-notify channel plugin.
 *
 * Registers itself as a Channel capability (`channel.sys-notify`) so the
 * notify plugin can discover it via `channel.list` and dispatch events to it.
 *
 * On send(), uses osascript on macOS and notify-send on Linux to display
 * a native OS notification. Falls back gracefully if the command is not found.
 */
export function createSysNotifyPlugin(): DriftPlugin {
  return {
    name: 'sys-notify',
    version: '0.1.0',

    async init(ctx: PluginContext) {
      const capabilities: ChannelCapabilities = {
        streaming: false,
        richContent: false,
        fileUpload: false,
        interactive: false,
      }

      const channel: Channel = {
        name: 'sys-notify',
        capabilities,

        async send(msg: OutgoingMessage) {
          const rawText = stripMarkdown(msg.content)

          // Extract a title from the first line if it looks like a header,
          // otherwise use the event name or a generic fallback.
          const lines = rawText.split('\n').filter(Boolean)
          let title = 'Drift'
          let body = rawText

          if (lines.length > 1) {
            title = lines[0].slice(0, 80)
            body = lines.slice(1).join('\n').trim()
          } else if (msg.metadata?.event && typeof msg.metadata.event === 'string') {
            title = msg.metadata.event
          }

          try {
            await sendOsNotification(title, body || rawText)
            ctx.logger.info(`[sys-notify] sent: "${title}"`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            ctx.logger.warn(`[sys-notify] failed to send notification: ${message}`)
          }
        },
      }

      ctx.register('channel.sys-notify', () => channel)
      ctx.logger.info(`[sys-notify] channel registered (platform: ${process.platform})`)
    },
  }
}

export default createSysNotifyPlugin
