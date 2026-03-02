// ── PostChatExtractor ─────────────────────────────────────
// Pure functions for extracting memories from completed chat sessions.

export interface ExtractionResult {
  facts: Array<{ type: string; key: string; value: string }>
  reminders: Array<{ content: string; remind_at: string }>
  topics: string[]
}

/**
 * Determine whether a session has enough messages to warrant extraction.
 * Short sessions (< 3 messages) rarely contain extractable information.
 */
export function shouldExtract(messageCount: number): boolean {
  return messageCount >= 3
}

/**
 * Parse the LLM's extraction response into a typed result.
 * Handles raw JSON, markdown code blocks, and partial/malformed output.
 */
export function parseExtractionResult(raw: string): ExtractionResult {
  const empty: ExtractionResult = { facts: [], reminders: [], topics: [] }
  try {
    // Try to extract JSON from markdown code block
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim()
    const parsed = JSON.parse(jsonStr)
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    }
  } catch {
    return empty
  }
}

export const EXTRACTION_PROMPT = `分析这段对话，提取以下信息（如果有的话）：
1. facts: 用户明确提到的事实、偏好、决定 → [{type, key, value}]
   type 可选: preference, fact, decision, event, pattern
2. reminders: 隐含的待办或截止日期 → [{content, remind_at}]
   remind_at 使用 ISO 8601 UTC 格式
3. topics: 对话涉及的核心主题关键词 → [string]

仅提取确定的信息，不推测。如果某类别没有可提取的内容，返回空数组。
输出纯 JSON，不要其他文字。`
