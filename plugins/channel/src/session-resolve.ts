import { nanoid } from 'nanoid'
import type { InboundMessage, SessionKey } from './types.js'

export function resolveSessionKey(msg: InboundMessage): SessionKey {
  return {
    channelId: msg.channelId,
    userId: (msg.metadata?.userId as string) ?? 'owner',
  }
}

export function sessionNamespace(key: SessionKey): string {
  return `${key.channelId}:${key.userId}`
}

export function resolveSessionId(msg: InboundMessage): string {
  const key = resolveSessionKey(msg)
  const ns = sessionNamespace(key)

  if (!msg.sessionId) {
    return `${ns}:${nanoid()}`
  }
  if (msg.sessionId.startsWith(`${ns}:`)) {
    return msg.sessionId
  }
  return `${ns}:${msg.sessionId}`
}
