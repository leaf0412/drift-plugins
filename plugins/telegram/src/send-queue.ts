// ── Rate-limited send queue for Telegram Bot API ──────────

import { TelegramApiError } from './api.js'

interface SendTask {
  fn: () => Promise<void>
  retries: number
}

export interface SendQueueOptions {
  /** Minimum interval between sends in ms (default: 1500) */
  interval?: number
  /** Fallback delay after rate-limit error in ms (default: 5000) */
  rateLimitFallbackDelay?: number
  /** Max retries per message (default: 2) */
  maxRetries?: number
}

export interface SendQueueLogger {
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

export class TelegramSendQueue {
  private queue: SendTask[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private processing = false
  private stopped = false

  private readonly interval: number
  private readonly rateLimitFallbackDelay: number
  private readonly maxRetries: number
  private readonly logger: SendQueueLogger

  constructor(logger: SendQueueLogger, options?: SendQueueOptions) {
    this.logger = logger
    this.interval = options?.interval ?? 1500
    this.rateLimitFallbackDelay = options?.rateLimitFallbackDelay ?? 5000
    this.maxRetries = options?.maxRetries ?? 2
  }

  enqueue(fn: () => Promise<void>): void {
    if (this.stopped) return
    this.queue.push({ fn, retries: 0 })
    this.scheduleNext()
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.processing || this.stopped || this.queue.length === 0) return
    this.processing = true
    if (!this.timer) {
      this.processOne()
    }
  }

  private async processOne(): Promise<void> {
    if (this.stopped || this.queue.length === 0) {
      this.processing = false
      this.timer = null
      return
    }

    const task = this.queue.shift()!

    try {
      await task.fn()
    } catch (err: unknown) {
      const retryAfter = err instanceof TelegramApiError ? err.retryAfter : undefined
      const msg = err instanceof Error ? err.message : String(err)

      if (retryAfter !== undefined && task.retries < this.maxRetries) {
        task.retries++
        this.queue.unshift(task)
        const delay = retryAfter > 0
          ? retryAfter * 1000
          : this.rateLimitFallbackDelay
        this.logger.warn(
          `Telegram rate limit, retry ${task.retries}/${this.maxRetries} after ${delay}ms`,
        )
        this.timer = setTimeout(() => this.processOne(), delay)
        return
      }

      this.logger.error(`Telegram send failed (retries=${task.retries}): ${msg}`)
    }

    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.processOne(), this.interval)
    } else {
      this.processing = false
      this.timer = null
    }
  }
}
