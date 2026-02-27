import { describe, it, expect } from 'vitest'
import { escapeHtml, truncate, splitMessage } from './html.js'

describe('escapeHtml', () => {
  it('escapes <, >, &', () => {
    expect(escapeHtml('<script>alert("xss")&</script>')).toBe(
      '&lt;script&gt;alert("xss")&amp;&lt;/script&gt;',
    )
  })

  it('leaves normal text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

describe('truncate', () => {
  it('does not truncate short text', () => {
    expect(truncate('short', 100)).toBe('short')
  })

  it('truncates long text with marker', () => {
    const long = 'a'.repeat(200)
    const result = truncate(long, 100)
    expect(result.length).toBeLessThanOrEqual(100)
    expect(result).toContain('(truncated)')
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('splits long text into chunks', () => {
    const text = 'a'.repeat(250)
    const chunks = splitMessage(text, 100)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(100)
    expect(chunks[1]).toHaveLength(100)
    expect(chunks[2]).toHaveLength(50)
  })
})
