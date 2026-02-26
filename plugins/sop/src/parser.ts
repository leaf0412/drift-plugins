// sop/parser.ts — Parse Markdown SOP files into Sop structs
import matter from 'gray-matter'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Sop, SopStep, SopTrigger, SopExecutionMode } from './types.js'

// ── Step Extraction ───────────────────────────────────────────

/**
 * Extract ordered steps from Markdown body.
 * Matches headings like "## Step 1: Title" or "## Step 2: Another Title".
 * The body of each step is everything up to the next Step heading or end of content.
 */
function extractSteps(markdownBody: string): SopStep[] {
  const steps: SopStep[] = []

  // Split on lines that begin a Step heading
  // Pattern: ## Step N: Title (N is any positive integer)
  const headingRegex = /^##\s+Step\s+(\d+):\s+(.+)$/m
  const parts = markdownBody.split(/(?=^##\s+Step\s+\d+:)/m)

  for (const part of parts) {
    const match = headingRegex.exec(part)
    if (!match) continue

    const number = parseInt(match[1], 10)
    const title = match[2].trim()

    // Body is everything after the heading line
    const afterHeading = part.slice(match.index + match[0].length)
    const body = afterHeading.trim()

    steps.push({ number, title, body })
  }

  return steps
}

// ── Trigger Parsing ──────────────────────────────────────────

function parseTriggers(raw: unknown): SopTrigger[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item: unknown) => {
    const t = item as Record<string, unknown>
    const trigger: SopTrigger = {
      type: (t.type as SopTrigger['type']) ?? 'manual',
    }
    if (t.expr) trigger.expr = String(t.expr)
    if (t.event) trigger.event = String(t.event)
    return trigger
  })
}

// ── Execution Mode ───────────────────────────────────────────

function parseExecutionMode(raw: unknown): SopExecutionMode {
  const valid: SopExecutionMode[] = ['auto', 'supervised', 'step_by_step']
  if (typeof raw === 'string' && valid.includes(raw as SopExecutionMode)) {
    return raw as SopExecutionMode
  }
  return 'auto'
}

// ── Main Parser ──────────────────────────────────────────────

/**
 * Parse a Markdown string with YAML frontmatter into a Sop struct.
 *
 * @param content  - raw Markdown file content
 * @param slug     - derived from filename (without extension)
 * @param filePath - absolute path to the source file
 */
export function parseSop(content: string, slug: string, filePath: string): Sop {
  const { data, content: body } = matter(content)

  return {
    slug,
    name: typeof data.name === 'string' ? data.name : slug,
    triggers: parseTriggers(data.triggers),
    executionMode: parseExecutionMode(data.execution),
    cooldownSecs: typeof data.cooldown === 'number' ? data.cooldown : 0,
    steps: extractSteps(body),
    filePath,
    enabled: data.enabled !== false,
  }
}

/**
 * Read an SOP Markdown file from disk and parse it.
 * Derives the slug from the filename (basename without extension).
 *
 * @param filePath - absolute path to the .md file
 */
export function parseSopFile(filePath: string): Sop {
  const content = readFileSync(filePath, 'utf-8')
  const slug = basename(filePath, extname(filePath))
  return parseSop(content, slug, filePath)
}
