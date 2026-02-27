import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TelegramApi, TelegramApiError } from './api.js'
import type { TelegramMessage } from './api.js'

// ── Helpers ─────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchOk<T>(result: T) {
  const fn = vi.fn().mockResolvedValue({
    status: 200,
    json: async () => ({ ok: true, result }),
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

function mockFetchError(
  status: number,
  description: string,
  retryAfter?: number,
) {
  const fn = vi.fn().mockResolvedValue({
    status,
    json: async () => ({
      ok: false,
      description,
      ...(retryAfter !== undefined && { parameters: { retry_after: retryAfter } }),
    }),
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

// ── Tests ────────────────────────────────────────────────────

describe('TelegramApi', () => {
  const TOKEN = 'test-bot-token'
  const api = new TelegramApi(TOKEN)

  it('constructs correct base URL', async () => {
    const mock = mockFetchOk(true)

    await api.deleteWebhook()

    const calledUrl = mock.mock.calls[0][0] as string
    expect(calledUrl).toBe(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`)
  })

  describe('sendMessage', () => {
    it('sends correct params and returns message', async () => {
      const fakeMsg: TelegramMessage = {
        message_id: 42,
        chat: { id: 123, type: 'private' },
        date: 1700000000,
        text: 'hello',
      }
      const mock = mockFetchOk(fakeMsg)

      const result = await api.sendMessage(123, 'hello', 'HTML')

      expect(result).toEqual(fakeMsg)
      expect(mock).toHaveBeenCalledTimes(1)

      const [url, opts] = mock.mock.calls[0]
      expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
      expect(opts.method).toBe('POST')
      expect(opts.headers['Content-Type']).toBe('application/json')

      const body = JSON.parse(opts.body)
      expect(body.chat_id).toBe(123)
      expect(body.text).toBe('hello')
      expect(body.parse_mode).toBe('HTML')
    })

    it('omits parse_mode when not provided', async () => {
      mockFetchOk({ message_id: 1, chat: { id: 1, type: 'private' }, date: 0 })

      await api.sendMessage(1, 'text')

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      expect(body.parse_mode).toBeUndefined()
    })
  })

  describe('editMessageText', () => {
    it('sends correct params', async () => {
      const fakeMsg: TelegramMessage = {
        message_id: 42,
        chat: { id: 123, type: 'private' },
        date: 1700000000,
        text: 'edited',
      }
      const mock = mockFetchOk(fakeMsg)

      const result = await api.editMessageText(123, 42, 'edited', 'Markdown')

      expect(result).toEqual(fakeMsg)
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.chat_id).toBe(123)
      expect(body.message_id).toBe(42)
      expect(body.text).toBe('edited')
      expect(body.parse_mode).toBe('Markdown')
    })
  })

  describe('sendMessageDraft', () => {
    it('calls sendMessageDraft endpoint with business_connection_id', async () => {
      const mock = mockFetchOk(true)

      const result = await api.sendMessageDraft(123, 'draft-1', 'Draft text')

      expect(result).toBe(true)
      const [url] = mock.mock.calls[0]
      expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessageDraft`)
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.chat_id).toBe(123)
      expect(body.text).toBe('Draft text')
      expect(body.business_connection_id).toBe('draft-1')
    })
  })

  describe('getUpdates', () => {
    it('sends correct params with defaults', async () => {
      const updates = [{ update_id: 1 }, { update_id: 2 }]
      const mock = mockFetchOk(updates)

      const result = await api.getUpdates(100)

      expect(result).toEqual(updates)
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.offset).toBe(100)
      expect(body.timeout).toBe(30)
    })

    it('omits offset when undefined', async () => {
      mockFetchOk([])

      await api.getUpdates()

      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
      expect(body.offset).toBeUndefined()
      expect(body.timeout).toBe(30)
    })
  })

  describe('setWebhook', () => {
    it('sends url with allowed_updates', async () => {
      const mock = mockFetchOk(true)

      const result = await api.setWebhook('https://example.com/webhook', 'secret-123')

      expect(result).toBe(true)
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.url).toBe('https://example.com/webhook')
      expect(body.allowed_updates).toEqual(['message'])
      expect(body.secret_token).toBe('secret-123')
    })
  })

  describe('setMyCommands', () => {
    it('sends commands array', async () => {
      const mock = mockFetchOk(true)
      const commands = [
        { command: 'start', description: 'Start the bot' },
        { command: 'help', description: 'Show help' },
      ]

      const result = await api.setMyCommands(commands)

      expect(result).toBe(true)
      const body = JSON.parse(mock.mock.calls[0][1].body)
      expect(body.commands).toEqual(commands)
    })
  })

  describe('error handling', () => {
    it('throws TelegramApiError on failure', async () => {
      mockFetchError(400, 'Bad Request: chat not found')

      await expect(api.sendMessage(999, 'fail')).rejects.toThrow(TelegramApiError)
      await expect(api.sendMessage(999, 'fail')).rejects.toMatchObject({
        message: 'Bad Request: chat not found',
        statusCode: 400,
        retryAfter: undefined,
      })
    })

    it('includes retry_after on 429', async () => {
      mockFetchError(429, 'Too Many Requests: retry after 30', 30)

      try {
        await api.sendMessage(123, 'spam')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(TelegramApiError)
        const apiErr = err as TelegramApiError
        expect(apiErr.statusCode).toBe(429)
        expect(apiErr.retryAfter).toBe(30)
        expect(apiErr.message).toBe('Too Many Requests: retry after 30')
      }
    })
  })
})
