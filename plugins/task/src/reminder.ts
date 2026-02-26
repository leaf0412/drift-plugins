import type Database from 'better-sqlite3'
import { getDueReminders, markNotified } from './service.js'

/**
 * Check for due task reminders, emit events, and mark as notified.
 * Recurrence is handled separately when a task is completed (status → done).
 *
 * @returns number of reminders emitted
 */
export async function checkReminders(
  db: Database.Database,
  emit: (event: string, data: unknown) => Promise<void> | void,
): Promise<number> {
  const dueTasks = getDueReminders(db)

  for (const task of dueTasks) {
    await emit('task.reminder', {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      due_at: task.due_at,
      tags: task.tags,
    })

    markNotified(db, task.id)
  }

  return dueTasks.length
}
