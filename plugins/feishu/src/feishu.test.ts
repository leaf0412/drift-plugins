import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AtomRegistry } from '@drift/core'
import type { PluginContext, LoggerLike, Channel } from '@drift/core'
import { createFeishuPlugin } from './index.js'
import {
  generateSign,
  sendFeishuWebhook,
  sendFeishuText,
  formatChatCompleteCard,
  formatTestCard,
  formatTaskReminderCard,
  formatCronResultCard,
  formatCronNotifyCard,
  formatCronChatCard,
  formatGenericCard,
} from './webhook.js'

// ── Helpers ─────────────────────────────────────────────────

const noopLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

function createMockContext(
  overrides?: Partial<PluginContext>,
): PluginContext {
  const atoms = new AtomRegistry()
  return {
    atoms,
    logger: noopLogger,
    tools: { register: () => {}, unregister: () => {}, list: () => [] },
    events: {
      on: () => () => {},
      emit: async () => {},
      off: () => {},
      clear: () => {},
    },
    routes: {
      get: () => {},
      post: () => {},
      put: () => {},
      delete: () => {},
    },
    storage: {
      queryAll: () => [],
      queryOne: () => undefined,
      execute: () => ({}),
      transaction: <T>(fn: () => T) => fn(),
    },
    config: {
      get: <T>(_k: string, d?: T) => d as T,
      set: () => {},
    },
    chat: async function* () {},
    channels: {
      register: () => {},
      unregister: () => {},
      get: () => undefined,
      list: () => [],
      broadcast: async () => {},
    },
    ...overrides,
  }
}

// ── Tests: Plugin ─────────────────────────────────────────

describe('createFeishuPlugin', () => {
  it('returns a valid DriftPlugin with correct manifest', () => {
    const plugin = createFeishuPlugin({ webhookUrl: 'https://example.com/hook' })

    expect(plugin.manifest.name).toBe('feishu')
    expect(plugin.manifest.version).toBe('1.0.0')
    expect(plugin.manifest.type).toBe('code')
    expect(plugin.manifest.depends).toEqual([])
    expect(plugin.manifest.capabilities.network).toBe(true)
    expect(typeof plugin.init).toBe('function')
  })

  it('init() registers a feishu Channel', async () => {
    const registered: Channel[] = []
    const ctx = createMockContext({
      channels: {
        register: (ch: Channel) => { registered.push(ch) },
        unregister: () => {},
        get: () => undefined,
        list: () => [],
        broadcast: async () => {},
      },
    })

    const plugin = createFeishuPlugin({ webhookUrl: 'https://example.com/hook' })
    await plugin.init(ctx)

    expect(registered.length).toBe(1)
    expect(registered[0].name).toBe('feishu')
    expect(registered[0].capabilities.streaming).toBe(false)
    expect(registered[0].capabilities.richContent).toBe(true)
    expect(registered[0].capabilities.fileUpload).toBe(false)
    expect(registered[0].capabilities.interactive).toBe(false)
  })

  it('channel.send() calls sendFeishuText for text messages', async () => {
    let registeredChannel: Channel | null = null

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, msg: 'ok' }),
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const ctx = createMockContext({
      channels: {
        register: (ch: Channel) => { registeredChannel = ch },
        unregister: () => {},
        get: () => undefined,
        list: () => [],
        broadcast: async () => {},
      },
    })

    const plugin = createFeishuPlugin({ webhookUrl: 'https://example.com/hook' })
    await plugin.init(ctx)

    await registeredChannel!.send({
      type: 'text',
      content: 'Hello world',
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/hook')
    const body = JSON.parse(opts.body)
    expect(body.msg_type).toBe('text')
    expect(body.content.text).toBe('Hello world')
  })

  it('channel.send() calls sendFeishuWebhook for card messages', async () => {
    let registeredChannel: Channel | null = null

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, msg: 'ok' }),
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const ctx = createMockContext({
      channels: {
        register: (ch: Channel) => { registeredChannel = ch },
        unregister: () => {},
        get: () => undefined,
        list: () => [],
        broadcast: async () => {},
      },
    })

    const plugin = createFeishuPlugin({ webhookUrl: 'https://example.com/hook' })
    await plugin.init(ctx)

    const card = formatChatCompleteCard({ content: 'test', model: 'gpt' })
    await registeredChannel!.send({
      type: 'card',
      content: '',
      metadata: { card },
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.msg_type).toBe('interactive')
    expect(body.card).toBeDefined()
  })
})

// ── Tests: Webhook ────────────────────────────────────────

describe('sendFeishuWebhook', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends correct POST payload without signing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, msg: 'ok' }),
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await sendFeishuWebhook(
      'https://hook.feishu.cn/test',
      { msg_type: 'text', content: { text: 'hello' } },
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://hook.feishu.cn/test')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body)
    expect(body.msg_type).toBe('text')
    expect(body.content.text).toBe('hello')
    expect(body.timestamp).toBeUndefined()
    expect(body.sign).toBeUndefined()
  })

  it('adds HMAC-SHA256 signature when secret is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, msg: 'ok' }),
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await sendFeishuWebhook(
      'https://hook.feishu.cn/test',
      { msg_type: 'text', content: { text: 'signed' } },
      'my-secret',
    )

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.timestamp).toBeDefined()
    expect(typeof body.timestamp).toBe('string')
    expect(body.sign).toBeDefined()
    expect(typeof body.sign).toBe('string')
    // sign should be base64
    expect(() => Buffer.from(body.sign, 'base64')).not.toThrow()
  })

  it('throws on non-ok HTTP response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      sendFeishuWebhook(
        'https://hook.feishu.cn/test',
        { msg_type: 'text', content: { text: 'fail' } },
      ),
    ).rejects.toThrow('Feishu webhook HTTP 500')
  })

  it('throws on Feishu API error code', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 19021, msg: 'sign match fail' }),
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await expect(
      sendFeishuWebhook(
        'https://hook.feishu.cn/test',
        { msg_type: 'text', content: { text: 'bad sign' } },
      ),
    ).rejects.toThrow('Feishu webhook error (19021): sign match fail')
  })
})

describe('sendFeishuText', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('wraps text into a proper text message payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, msg: 'ok' }),
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await sendFeishuText('https://hook.feishu.cn/test', 'simple message')

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.msg_type).toBe('text')
    expect(body.content).toEqual({ text: 'simple message' })
  })
})

// ── Tests: Signature ──────────────────────────────────────

describe('generateSign', () => {
  it('produces a base64-encoded HMAC-SHA256 signature', () => {
    const sign = generateSign('1234567890', 'test-secret')
    expect(typeof sign).toBe('string')
    expect(sign.length).toBeGreaterThan(0)

    // Should be valid base64
    const decoded = Buffer.from(sign, 'base64')
    expect(decoded.length).toBe(32) // SHA-256 = 32 bytes
  })

  it('produces consistent results for same inputs', () => {
    const sign1 = generateSign('1000000000', 'secret')
    const sign2 = generateSign('1000000000', 'secret')
    expect(sign1).toBe(sign2)
  })

  it('produces different results for different timestamps', () => {
    const sign1 = generateSign('1000000000', 'secret')
    const sign2 = generateSign('1000000001', 'secret')
    expect(sign1).not.toBe(sign2)
  })
})

// ── Tests: Card Formatters ────────────────────────────────

describe('card formatters', () => {
  it('formatChatCompleteCard returns a valid interactive card', () => {
    const card = formatChatCompleteCard({
      sessionId: 'sess-1',
      content: 'Hello response',
      model: 'claude-3',
      usage: { promptTokens: 100, completionTokens: 50 },
    })

    expect(card.msg_type).toBe('interactive')
    expect(card.card).toBeDefined()
    expect((card.card as Record<string, unknown>).header).toBeDefined()
    expect((card.card as Record<string, unknown>).elements).toBeDefined()

    const header = (card.card as Record<string, Record<string, unknown>>).header
    expect(header.template).toBe('blue')

    const elements = (card.card as Record<string, unknown[]>).elements
    expect(elements.length).toBeGreaterThanOrEqual(1)
  })

  it('formatChatCompleteCard truncates long content', () => {
    const longContent = 'x'.repeat(500)
    const card = formatChatCompleteCard({ content: longContent })
    const elements = (card.card as Record<string, unknown[]>).elements
    const mdElement = elements[0] as Record<string, string>
    expect(mdElement.content.length).toBeLessThan(500)
    expect(mdElement.content).toContain('...')
  })

  it('formatTestCard returns a green interactive card', () => {
    const card = formatTestCard()

    expect(card.msg_type).toBe('interactive')
    const header = (card.card as Record<string, Record<string, unknown>>).header
    expect(header.template).toBe('green')
  })

  it('formatTaskReminderCard includes priority and due date', () => {
    const card = formatTaskReminderCard({
      taskId: 'task-1',
      title: 'Important Task',
      priority: 'high',
      dueAt: '2026-03-01T10:00:00Z',
    })

    expect(card.msg_type).toBe('interactive')
    const header = (card.card as Record<string, Record<string, unknown>>).header
    expect(header.template).toBe('orange')

    const elements = (card.card as Record<string, unknown[]>).elements
    const mdElement = elements[0] as Record<string, string>
    expect(mdElement.content).toContain('Important Task')
    expect(mdElement.content).toContain('High')
  })

  it('formatCronResultCard includes job name and truncated data', () => {
    const card = formatCronResultCard({
      jobName: 'daily-check',
      url: 'https://api.example.com',
      status: 200,
      data: { result: 'ok' },
    })

    expect(card.msg_type).toBe('interactive')
    const elements = (card.card as Record<string, unknown[]>).elements
    expect(elements.length).toBeGreaterThanOrEqual(1)

    const noteElement = elements[1] as Record<string, unknown[]>
    const noteText = (noteElement.elements[0] as Record<string, string>).content
    expect(noteText).toContain('https://api.example.com')
    expect(noteText).toContain('HTTP 200')
  })

  it('formatCronNotifyCard includes job name and message', () => {
    const card = formatCronNotifyCard({
      jobName: 'reminder',
      message: 'Time to check stocks',
    })

    expect(card.msg_type).toBe('interactive')
    const header = (card.card as Record<string, Record<string, unknown>>).header
    expect(header.template).toBe('green')

    const elements = (card.card as Record<string, unknown[]>).elements
    const md = elements[0] as Record<string, string>
    expect(md.content).toBe('Time to check stocks')
  })

  it('formatCronChatCard includes content and optional sessionId', () => {
    const card = formatCronChatCard({
      jobName: 'daily-ai',
      content: 'AI summary here',
      sessionId: 'sess-123',
    })

    expect(card.msg_type).toBe('interactive')
    const header = (card.card as Record<string, Record<string, unknown>>).header
    expect(header.template).toBe('purple')

    const elements = (card.card as Record<string, unknown[]>).elements
    expect(elements.length).toBe(2)
    const note = elements[1] as Record<string, unknown[]>
    const noteText = (note.elements[0] as Record<string, string>).content
    expect(noteText).toContain('sess-123')
  })

  it('formatCronChatCard works without sessionId', () => {
    const card = formatCronChatCard({
      jobName: 'daily-ai',
      content: 'No session',
    })

    const elements = (card.card as Record<string, unknown[]>).elements
    expect(elements.length).toBe(1) // No note element
  })

  it('formatGenericCard wraps arbitrary data', () => {
    const card = formatGenericCard('custom.event', { foo: 'bar' })

    expect(card.msg_type).toBe('interactive')
    const header = (card.card as Record<string, Record<string, unknown>>).header
    expect(header.template).toBe('turquoise')
    const title = (header.title as Record<string, string>).content
    expect(title).toContain('custom.event')
  })
})
