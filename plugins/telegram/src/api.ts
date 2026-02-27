// ── Types ────────────────────────────────────────────────

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
}

export interface TelegramMessage {
  message_id: number
  chat: TelegramChat
  from?: TelegramUser
  date: number
  text?: string
  entities?: TelegramMessageEntity[]
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  parameters?: { retry_after?: number }
}

// ── Error ────────────────────────────────────────────────

export class TelegramApiError extends Error {
  readonly statusCode: number
  readonly retryAfter?: number

  constructor(message: string, statusCode: number, retryAfter?: number) {
    super(message)
    this.name = 'TelegramApiError'
    this.statusCode = statusCode
    this.retryAfter = retryAfter
  }
}

// ── API Client ───────────────────────────────────────────

export class TelegramApi {
  private readonly baseUrl: string

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const timeoutMs = method === 'getUpdates' ? 60_000 : 10_000
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const data = (await res.json()) as TelegramApiResponse<T>

    if (!data.ok) {
      throw new TelegramApiError(
        data.description ?? `Telegram API error: ${method}`,
        res.status,
        data.parameters?.retry_after,
      )
    }

    return data.result as T
  }

  // ── Public Methods ───────────────────────────────────────

  async sendMessage(
    chatId: number | string,
    text: string,
    parseMode?: string,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(parseMode && { parse_mode: parseMode }),
    })
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    parseMode?: string,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(parseMode && { parse_mode: parseMode }),
    })
  }

  async sendMessageDraft(
    chatId: number | string,
    draftId: string,
    text: string,
    parseMode?: string,
  ): Promise<true> {
    return this.call<true>('sendMessageDraft', {
      chat_id: chatId,
      business_connection_id: draftId,
      text,
      ...(parseMode && { parse_mode: parseMode }),
    })
  }

  async getUpdates(
    offset?: number,
    timeout = 30,
    allowedUpdates?: string[],
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      ...(offset !== undefined && { offset }),
      timeout,
      ...(allowedUpdates && { allowed_updates: allowedUpdates }),
    })
  }

  async setWebhook(url: string, secretToken?: string): Promise<true> {
    return this.call<true>('setWebhook', {
      url,
      allowed_updates: ['message'],
      ...(secretToken && { secret_token: secretToken }),
    })
  }

  async deleteWebhook(): Promise<true> {
    return this.call<true>('deleteWebhook', {})
  }

  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
  ): Promise<true> {
    return this.call<true>('setMyCommands', { commands })
  }
}
