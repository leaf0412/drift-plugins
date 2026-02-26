import { createHmac } from 'node:crypto'

// ── Types ──────────────────────────────────────────────────

interface FeishuTextMessage {
  msg_type: 'text'
  content: { text: string }
}

interface FeishuCardMessage {
  msg_type: 'interactive'
  card: Record<string, unknown>
}

export type FeishuMessage = FeishuTextMessage | FeishuCardMessage

interface FeishuWebhookResponse {
  code: number
  msg: string
}

// ── Signature ──────────────────────────────────────────────

export function generateSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`
  return createHmac('sha256', stringToSign).update('').digest('base64')
}

// ── Send ───────────────────────────────────────────────────

export async function sendFeishuWebhook(
  webhookUrl: string,
  message: FeishuMessage,
  secret?: string,
): Promise<void> {
  const body: Record<string, unknown> = { ...message }

  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    body.timestamp = timestamp
    body.sign = generateSign(timestamp, secret)
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Feishu webhook HTTP ${res.status}: ${text}`)
  }

  const data = (await res.json()) as FeishuWebhookResponse
  if (data.code !== 0) {
    throw new Error(`Feishu webhook error (${data.code}): ${data.msg}`)
  }
}

// ── Text shortcut ──────────────────────────────────────────

export function sendFeishuText(
  webhookUrl: string,
  text: string,
  secret?: string,
): Promise<void> {
  return sendFeishuWebhook(
    webhookUrl,
    { msg_type: 'text', content: { text } },
    secret,
  )
}

// ── Card Formatters ────────────────────────────────────────

export function formatChatCompleteCard(data: {
  sessionId?: string
  content?: string
  model?: string
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}): FeishuCardMessage {
  const content = data.content ?? ''
  const model = data.model ?? 'unknown'
  const usage = data.usage
  const preview = content.length > 300 ? content.slice(0, 300) + '...' : content

  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: preview },
  ]

  const infoParts: string[] = []
  if (model) infoParts.push(`Model: ${model}`)
  if (usage) {
    infoParts.push(`Tokens: ${usage.promptTokens ?? 0} -> ${usage.completionTokens ?? 0}`)
  }
  if (data.sessionId) {
    infoParts.push(`Session: ${data.sessionId}`)
  }

  if (infoParts.length > 0) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: infoParts.join('  |  ') }],
    })
  }

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: 'Drift -- Chat Complete' },
        template: 'blue',
      },
      elements,
    },
  }
}

export function formatTestCard(): FeishuCardMessage {
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: 'Drift -- Webhook Test' },
        template: 'green',
      },
      elements: [
        {
          tag: 'markdown',
          content: 'Feishu webhook is working! Connected to Drift daemon.',
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: `Time: ${new Date().toISOString()}` },
          ],
        },
      ],
    },
  }
}

export function formatTaskReminderCard(data: {
  taskId: string
  title: string
  priority: string
  dueAt: string | null
}): FeishuCardMessage {
  const priorityMap: Record<string, string> = {
    urgent: 'Urgent',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  }
  const priorityLabel = priorityMap[data.priority] ?? data.priority
  const dueLabel = data.dueAt
    ? new Date(data.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : 'No deadline'

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: 'Drift -- Task Reminder' },
        template: 'orange',
      },
      elements: [
        {
          tag: 'markdown',
          content: `**${data.title}**\n\nPriority: ${priorityLabel}\nDue: ${dueLabel}`,
        },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: `Task ID: ${data.taskId}` },
          ],
        },
      ],
    },
  }
}

export function formatCronResultCard(data: {
  jobName: string
  url: string
  status: number
  data: unknown
}): FeishuCardMessage {
  const preview =
    typeof data.data === 'string'
      ? data.data
      : JSON.stringify(data.data, null, 2)
  const truncated =
    preview.length > 800 ? preview.slice(0, 800) + '...' : preview

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: data.jobName },
        template: 'blue',
      },
      elements: [
        { tag: 'markdown', content: `\`\`\`json\n${truncated}\n\`\`\`` },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: `${data.url}  |  HTTP ${data.status}` },
          ],
        },
      ],
    },
  }
}

export function formatCronNotifyCard(data: {
  jobName: string
  message: string
}): FeishuCardMessage {
  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: data.jobName },
        template: 'green',
      },
      elements: [{ tag: 'markdown', content: data.message }],
    },
  }
}

export function formatCronChatCard(data: {
  jobName: string
  content: string
  sessionId?: string
}): FeishuCardMessage {
  const content = data.content || '(empty)'
  const truncated =
    content.length > 2000 ? content.slice(0, 2000) + '\n\n...(truncated)' : content

  const elements: Record<string, unknown>[] = [
    { tag: 'markdown', content: truncated },
  ]

  if (data.sessionId) {
    elements.push({
      tag: 'note',
      elements: [
        { tag: 'plain_text', content: `Session: ${data.sessionId}` },
      ],
    })
  }

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: data.jobName },
        template: 'purple',
      },
      elements,
    },
  }
}

export function formatGenericCard(
  event: string,
  data: unknown,
): FeishuCardMessage {
  const preview =
    typeof data === 'string'
      ? data
      : JSON.stringify(data, null, 2).slice(0, 300)

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `Drift -- ${event}` },
        template: 'turquoise',
      },
      elements: [
        { tag: 'markdown', content: `\`\`\`\n${preview}\n\`\`\`` },
      ],
    },
  }
}
