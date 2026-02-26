// memory/digest-agent.ts — Ensure the memory-digest scheduled agent definition exists
import path from 'node:path'
import fs from 'node:fs'

// ── Agent Definition Content ────────────────────────────────

const AGENT_MD = `---
name: Memory Digest
description: Daily extraction of key facts from conversations into persistent memory
trigger:
  type: cron
  expr: "0 0 * * *"
autonomy: full
output:
  notify: false
  journal: true
permissions:
  allowed_tools:
    - memory_save
    - memory_list
    - mind_read
    - mind_write
    - mind_search
session: new
enabled: true
---

# Memory Digest Agent

You are a memory extraction agent. Your job is to review today's conversations,
extract key facts and decisions, and persist them for long-term recall.

## Steps

### 1. Fetch today's sessions

Query the daemon API to get all sessions from today:

\`\`\`bash
curl -s "http://localhost:3141/api/sessions?from=$(date -u +%Y-%m-%dT00:00:00Z)&to=$(date -u +%Y-%m-%dT23:59:59Z)"
\`\`\`

For each session with messages, fetch the full conversation:

\`\`\`bash
curl -s "http://localhost:3141/api/sessions/<id>"
\`\`\`

### 2. Extract facts

For each conversation, identify and extract:

- **Decisions**: choices made about architecture, tools, workflow
- **Preferences**: user preferences expressed (editor, style, naming conventions)
- **Facts**: factual information learned (API endpoints, config values, project structure)
- **Patterns**: recurring themes or workflows observed
- **Issues**: bugs or problems encountered and their solutions

Structure each fact as \`{type, key, value}\` where:
- \`type\`: one of \`decision\`, \`preference\`, \`fact\`, \`pattern\`, \`issue\`
- \`key\`: a short, unique identifier (kebab-case)
- \`value\`: a concise description

### 3. Save via memory_save

For each extracted fact, call the \`memory_save\` tool:

\`\`\`
memory_save({ type: "<type>", key: "<key>", value: "<value>" })
\`\`\`

Skip facts that already exist with the same key and value (check with \`memory_list\` first).

### 4. Update MEMORY.md

Read the current MEMORY.md via \`mind_read\`, then update it with any new
structural knowledge (architecture changes, new patterns, updated workflows)
using \`mind_write\`. Only modify sections that need updating; preserve
user-written content.

### 5. Append journal summary

Append a brief summary of extracted memories to today's journal entry
using \`mind_write\` at \`journal/<YYYY-MM-DD>.md\`. Format:

\`\`\`markdown
## Memory Digest

- Extracted N new facts from M conversations
- Key topics: <topic1>, <topic2>, ...
- Notable: <any significant decisions or changes>
\`\`\`

## Guidelines

- Be conservative: only extract genuinely useful, non-obvious information
- Deduplicate: check existing memories before saving duplicates
- Respect privacy: never extract secrets, tokens, or credentials
- Keep values concise: under 200 characters per value
- Prefer updating existing memory entries over creating near-duplicates
`

// ── Public API ──────────────────────────────────────────────

/**
 * Ensure the memory-digest agent definition exists at
 * `{mindDir}/agents/memory-digest/agent.md`.
 *
 * Does NOT overwrite if the file already exists (preserves user customization).
 */
export function ensureMemoryDigestAgent(mindDir: string): void {
  const agentDir = path.join(mindDir, 'agents', 'memory-digest')
  const agentMdPath = path.join(agentDir, 'agent.md')

  if (fs.existsSync(agentMdPath)) return

  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(agentMdPath, AGENT_MD, 'utf-8')
}
