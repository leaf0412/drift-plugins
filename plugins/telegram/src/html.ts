// ── Lightweight HTML utilities for Telegram Bot API ──────────

export const MAX_MESSAGE_LENGTH = 4096

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const TRUNCATION_MARKER = '\n(truncated)'

export function truncate(text: string, limit = MAX_MESSAGE_LENGTH): string {
  if (text.length <= limit) return text
  return text.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, limit))
    remaining = remaining.slice(limit)
  }
  return chunks
}
