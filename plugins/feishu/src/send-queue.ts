// ── Rate-limited send queue for Feishu webhook ──────────

interface SendTask {
  fn: () => Promise<void>
  retries: number
}

export interface SendQueueOptions {
  /** Minimum interval between sends in ms (default: 1500) */
  interval?: number
  /** Delay after rate-limit error before retry in ms (default: 5000) */
  rateLimitDelay?: number
  /** Max retries per message (default: 2) */
  maxRetries?: number
}

export interface SendQueueLogger {
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

const RATE_LIMIT_PATTERN = /\(11232\)/

export class WebhookSendQueue {
  private queue: SendTask[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private processing = false
  private stopped = false

  private readonly interval: number
  private readonly rateLimitDelay: number
  private readonly maxRetries: number
  private readonly logger: SendQueueLogger

  constructor(logger: SendQueueLogger, options?: SendQueueOptions) {
    this.logger = logger
    this.interval = options?.interval ?? 1500
    this.rateLimitDelay = options?.rateLimitDelay ?? 5000
    this.maxRetries = options?.maxRetries ?? 2
  }

  /** Enqueue a send task for rate-limited execution */
  enqueue(fn: () => Promise<void>): void {
    if (this.stopped) return
    this.queue.push({ fn, retries: 0 })
    this.scheduleNext()
  }

  /** Stop the queue and discard pending items */
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
    // First item can go immediately if timer is not set,
    // subsequent items wait for the interval
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
      const msg = err instanceof Error ? err.message : String(err)

      if (RATE_LIMIT_PATTERN.test(msg) && task.retries < this.maxRetries) {
        // Rate limited — re-enqueue at front with exponential backoff
        task.retries++
        this.queue.unshift(task)
        const delay = this.rateLimitDelay * task.retries
        this.logger.warn(
          `Feishu rate limit hit, retry ${task.retries}/${this.maxRetries} after ${delay}ms`,
        )
        this.timer = setTimeout(() => this.processOne(), delay)
        return
      }

      // Non-rate-limit error or max retries exceeded — drop the message
      this.logger.error(`Feishu send failed (retries=${task.retries}): ${msg}`)
    }

    // Schedule next item after interval
    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.processOne(), this.interval)
    } else {
      this.processing = false
      this.timer = null
    }
  }
}
