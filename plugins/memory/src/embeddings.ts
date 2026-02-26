import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  apiKey: string
  baseURL?: string
  model?: string // default: text-embedding-3-small
}

export interface MemoryEntry {
  id: string
  project: string
  type: string
  key: string
  value: string
  distance: number
  createdAt: string
  updatedAt: string
}

export interface EmbeddingService {
  embed(text: string): Promise<number[] | null>
  embedBatch(texts: string[]): Promise<(number[] | null)[]>
  storeEmbedding(db: Database.Database, memoryId: string, text: string): Promise<void>
  recallSimilar(db: Database.Database, query: string, limit?: number): Promise<Array<{ id: string; distance: number }>>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'text-embedding-3-small'

export function createEmbeddingService(config: EmbeddingConfig): EmbeddingService {
  const baseURL = config.baseURL ?? 'https://api.openai.com/v1'
  const model = config.model ?? DEFAULT_MODEL

  async function embed(text: string): Promise<number[] | null> {
    try {
      const res = await fetch(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text.slice(0, 8000),
        }),
      })

      if (!res.ok) {
        return null
      }

      const data = await res.json() as {
        data: Array<{ embedding: number[] }>
      }
      return data.data[0]?.embedding ?? null
    } catch {
      return null
    }
  }

  async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    try {
      const res = await fetch(`${baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: texts.map(t => t.slice(0, 8000)),
        }),
      })

      if (!res.ok) {
        return texts.map(() => null)
      }

      const data = await res.json() as {
        data: Array<{ embedding: number[]; index: number }>
      }

      const result: (number[] | null)[] = texts.map(() => null)
      for (const item of data.data) {
        result[item.index] = item.embedding
      }
      return result
    } catch {
      return texts.map(() => null)
    }
  }

  async function storeEmbedding(db: Database.Database, memoryId: string, text: string): Promise<void> {
    const vector = await embed(text)
    if (!vector) return

    try {
      db.prepare('DELETE FROM memory_vec WHERE id = ?').run(memoryId)
      db.prepare(
        'INSERT INTO memory_vec (id, embedding) VALUES (?, ?)'
      ).run(memoryId, new Float32Array(vector))
    } catch {
      // vector table may not exist
    }
  }

  async function recallSimilar(
    db: Database.Database,
    query: string,
    limit = 5,
  ): Promise<Array<{ id: string; distance: number }>> {
    const vector = await embed(query)
    if (!vector) return []

    try {
      const rows = db.prepare(`
        SELECT id, distance
        FROM memory_vec
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(new Float32Array(vector), limit) as Array<{ id: string; distance: number }>

      return rows
    } catch {
      return []
    }
  }

  return { embed, embedBatch, storeEmbedding, recallSimilar }
}
