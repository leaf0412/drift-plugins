import { describe, it, expect, vi } from 'vitest'
import { createWebChannel } from './web-channel.js'
import type { OutboundMessage, InboundMessage } from './types.js'

// ── Tests ─────────────────────────────────────────────────────

describe('createWebChannel', () => {
  it('has id "web" and streaming capability', () => {
    const ch = createWebChannel()
    expect(ch.id).toBe('web')
    expect(ch.capabilities.text).toBe(true)
    expect(ch.capabilities.streaming).toBe(true)
    expect(ch.meta.name).toBe('Web')
  })

  it('listen() registers a handler and returns an unsubscribe fn', () => {
    const ch = createWebChannel()
    const handler = vi.fn()
    const unsub = ch.messaging.listen(handler)
    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('listen() receives messages pushed via pushInbound()', async () => {
    const ch = createWebChannel()
    const received: InboundMessage[] = []
    ch.messaging.listen((msg) => { received.push(msg) })

    const msg: InboundMessage = {
      channelId: 'web',
      sessionId: 'sess-1',
      content: 'hello from web',
    }
    await ch.pushInbound(msg)

    expect(received).toHaveLength(1)
    expect(received[0].content).toBe('hello from web')
  })

  it('multiple listen() handlers all receive the message', async () => {
    const ch = createWebChannel()
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    ch.messaging.listen(handler1)
    ch.messaging.listen(handler2)

    await ch.pushInbound({ channelId: 'web', sessionId: 's', content: 'x' })

    expect(handler1).toHaveBeenCalledOnce()
    expect(handler2).toHaveBeenCalledOnce()
  })

  it('unsubscribed handlers do not receive messages', async () => {
    const ch = createWebChannel()
    const handler = vi.fn()
    const unsub = ch.messaging.listen(handler)
    unsub()

    await ch.pushInbound({ channelId: 'web', sessionId: 's', content: 'x' })

    expect(handler).not.toHaveBeenCalled()
  })

  describe('messaging.send()', () => {
    it('send() stores the last sent message for test inspection', async () => {
      const ch = createWebChannel()
      const reply: OutboundMessage = { type: 'text', content: 'pong' }
      await ch.messaging.send(reply)
      expect(ch.lastSent).toEqual(reply)
    })

    it('send() calls onSend callback if provided', async () => {
      const onSend = vi.fn()
      const ch = createWebChannel({ onSend })
      const reply: OutboundMessage = { type: 'text', content: 'response' }
      await ch.messaging.send(reply)
      expect(onSend).toHaveBeenCalledWith(reply)
    })
  })

  describe('streaming adapter', () => {
    it('has a StreamingAdapter', () => {
      const ch = createWebChannel()
      expect(ch.streaming).toBeDefined()
      expect(typeof ch.streaming!.startStream).toBe('function')
      expect(typeof ch.streaming!.write).toBe('function')
      expect(typeof ch.streaming!.end).toBe('function')
    })

    it('write() calls onStreamWrite callback if provided', async () => {
      const onStreamWrite = vi.fn()
      const ch = createWebChannel({ onStreamWrite })
      await ch.streaming!.write('sess-1', { type: 'stream_delta', content: 'hello' })
      expect(onStreamWrite).toHaveBeenCalledWith('sess-1', { type: 'stream_delta', content: 'hello' })
    })

    it('end() calls onStreamEnd callback if provided', async () => {
      const onStreamEnd = vi.fn()
      const ch = createWebChannel({ onStreamEnd })
      await ch.streaming!.end('sess-1')
      expect(onStreamEnd).toHaveBeenCalledWith('sess-1')
    })
  })
})
