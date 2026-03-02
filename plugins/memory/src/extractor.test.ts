import { describe, it, expect } from 'vitest'
import { parseExtractionResult, shouldExtract } from './extractor.js'

describe('shouldExtract', () => {
  it('should return false for < 3 messages', () => {
    expect(shouldExtract(0)).toBe(false)
    expect(shouldExtract(1)).toBe(false)
    expect(shouldExtract(2)).toBe(false)
  })

  it('should return true for >= 3 messages', () => {
    expect(shouldExtract(3)).toBe(true)
    expect(shouldExtract(4)).toBe(true)
    expect(shouldExtract(100)).toBe(true)
  })
})

describe('parseExtractionResult', () => {
  it('should parse valid JSON', () => {
    const raw = JSON.stringify({
      facts: [{ type: 'preference', key: 'editor', value: 'vim' }],
      reminders: [{ content: 'Deploy v2', remind_at: '2026-03-10T09:00:00.000Z' }],
      topics: ['deployment'],
    })
    const result = parseExtractionResult(raw)
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0]).toEqual({ type: 'preference', key: 'editor', value: 'vim' })
    expect(result.reminders).toHaveLength(1)
    expect(result.reminders[0]).toEqual({ content: 'Deploy v2', remind_at: '2026-03-10T09:00:00.000Z' })
    expect(result.topics).toContain('deployment')
  })

  it('should handle malformed JSON', () => {
    const result = parseExtractionResult('not json')
    expect(result.facts).toHaveLength(0)
    expect(result.reminders).toHaveLength(0)
    expect(result.topics).toHaveLength(0)
  })

  it('should extract from code blocks', () => {
    const raw = '```json\n{"facts":[],"reminders":[],"topics":["test"]}\n```'
    const result = parseExtractionResult(raw)
    expect(result.topics).toContain('test')
  })

  it('should handle code blocks without language tag', () => {
    const raw = '```\n{"facts":[{"type":"fact","key":"lang","value":"ts"}],"reminders":[],"topics":[]}\n```'
    const result = parseExtractionResult(raw)
    expect(result.facts).toHaveLength(1)
    expect(result.facts[0].key).toBe('lang')
  })

  it('should handle partial results', () => {
    const raw = JSON.stringify({ facts: [{ type: 'fact', key: 'a', value: 'b' }] })
    const result = parseExtractionResult(raw)
    expect(result.facts).toHaveLength(1)
    expect(result.reminders).toHaveLength(0)
    expect(result.topics).toHaveLength(0)
  })

  it('should handle empty object', () => {
    const result = parseExtractionResult('{}')
    expect(result.facts).toHaveLength(0)
    expect(result.reminders).toHaveLength(0)
    expect(result.topics).toHaveLength(0)
  })

  it('should handle non-array fields gracefully', () => {
    const raw = JSON.stringify({ facts: 'not-array', reminders: null, topics: 42 })
    const result = parseExtractionResult(raw)
    expect(result.facts).toHaveLength(0)
    expect(result.reminders).toHaveLength(0)
    expect(result.topics).toHaveLength(0)
  })

  it('should handle empty string', () => {
    const result = parseExtractionResult('')
    expect(result.facts).toHaveLength(0)
    expect(result.reminders).toHaveLength(0)
    expect(result.topics).toHaveLength(0)
  })
})
