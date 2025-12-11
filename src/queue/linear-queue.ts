import { getDatabase, type TaskStatus, type LinearTaskType, type Priority } from './database.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'linear-queue' });

export interface LinearQueueItem {
  id: number;
  ticketId: string;
  ticketIdentifier: string;
  taskType: LinearTaskType;
  status: TaskStatus;
  priority: Priority;
  readinessScore: number | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  retryCount: number;
  maxRetries: number;
  errorMessage: string | null;
  inputData: Record<string, unknown> | null;
  outputData: Record<string, unknown> | null;
}

interface DbRow {
  id: number;
  ticket_id: string;
  ticket_identifier: string;
  task_type: string;
  status: string;
  priority: number;
  readiness_score: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  input_data: string | null;
  output_data: string | null;
}

function rowToItem(row: DbRow): LinearQueueItem {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    ticketIdentifier: row.ticket_identifier,
    taskType: row.task_type as LinearTaskType,
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    readinessScore: row.readiness_score,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    errorMessage: row.error_message,
    inputData: row.input_data ? JSON.parse(row.input_data) : null,
    outputData: row.output_data ? JSON.parse(row.output_data) : null,
  };
}

export class LinearTicketQueue {
  /**
   * Add a new task to the queue
   * Uses INSERT OR IGNORE to prevent duplicates (based on ticket_id + task_type + status)
   */
  enqueue(params: {
    ticketId: string;
    ticketIdentifier: string;
    taskType: LinearTaskType;
    priority: Priority;
    readinessScore?: number;
    inputData?: Record<string, unknown>;
    maxRetries?: number;
  }): LinearQueueItem | null {
    const db = getDatabase();

    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO linear_ticket_queue
        (ticket_id, ticket_identifier, task_type, priority, readiness_score, input_data, max_retries)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        params.ticketId,
        params.ticketIdentifier,
        params.taskType,
        params.priority,
        params.readinessScore ?? null,
        params.inputData ? JSON.stringify(params.inputData) : null,
        params.maxRetries ?? 3
      );

      if (result.changes === 0) {
        // Already exists
        logger.debug(
          { ticketId: params.ticketIdentifier, taskType: params.taskType },
          'Task already in queue'
        );
        return null;
      }

      const item = this.getById(result.lastInsertRowid as number);
      logger.info(
        { ticketId: params.ticketIdentifier, taskType: params.taskType, id: item?.id },
        'Task enqueued'
      );
      return item;
    } catch (error) {
      logger.error({ error, params }, 'Failed to enqueue task');
      throw error;
    }
  }

  /**
   * Get the next pending task, ordered by:
   * 1. Priority (1=urgent first, 4=low last)
   * 2. Readiness score (higher first)
   * 3. Created time (oldest first)
   */
  dequeue(): LinearQueueItem | null {
    const db = getDatabase();

    const transaction = db.transaction(() => {
      // Find next pending item
      const row = db.prepare(`
        SELECT * FROM linear_ticket_queue
        WHERE status = 'pending'
        ORDER BY
          priority ASC,
          COALESCE(readiness_score, 0) DESC,
          created_at ASC
        LIMIT 1
      `).get() as DbRow | undefined;

      if (!row) {
        return null;
      }

      // Mark as processing
      db.prepare(`
        UPDATE linear_ticket_queue
        SET status = 'processing',
            started_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(row.id);

      // Return updated row
      return db.prepare('SELECT * FROM linear_ticket_queue WHERE id = ?').get(row.id) as DbRow;
    });

    const result = transaction();

    if (result) {
      const item = rowToItem(result);
      logger.info(
        { ticketId: item.ticketIdentifier, taskType: item.taskType, id: item.id },
        'Task dequeued for processing'
      );
      return item;
    }

    return null;
  }

  /**
   * Mark a task as completed with optional output data
   */
  complete(id: number, outputData?: Record<string, unknown>): void {
    const db = getDatabase();

    db.prepare(`
      UPDATE linear_ticket_queue
      SET status = 'completed',
          completed_at = datetime('now'),
          updated_at = datetime('now'),
          output_data = ?
      WHERE id = ?
    `).run(outputData ? JSON.stringify(outputData) : null, id);

    logger.info({ id }, 'Task completed');
  }

  /**
   * Mark a task as failed
   * If retries remain, requeue as pending
   */
  fail(id: number, errorMessage: string): boolean {
    const db = getDatabase();

    const transaction = db.transaction(() => {
      const row = db.prepare('SELECT * FROM linear_ticket_queue WHERE id = ?').get(id) as
        | DbRow
        | undefined;

      if (!row) {
        return false;
      }

      const newRetryCount = row.retry_count + 1;

      if (newRetryCount < row.max_retries) {
        // Before setting this task back to pending, cancel any duplicate pending tasks
        // that may have been created by the scheduler while this task was processing.
        // This prevents UNIQUE constraint violations on (ticket_id, task_type, status).
        db.prepare(`
          UPDATE linear_ticket_queue
          SET status = 'cancelled',
              updated_at = datetime('now')
          WHERE ticket_id = ? AND task_type = ? AND status = 'pending' AND id != ?
        `).run(row.ticket_id, row.task_type, id);

        // Requeue for retry
        db.prepare(`
          UPDATE linear_ticket_queue
          SET status = 'pending',
              retry_count = ?,
              error_message = ?,
              started_at = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(newRetryCount, errorMessage, id);

        logger.warn(
          { id, retryCount: newRetryCount, maxRetries: row.max_retries },
          'Task failed, requeued for retry'
        );
        return true; // Will retry
      } else {
        // Max retries exceeded
        db.prepare(`
          UPDATE linear_ticket_queue
          SET status = 'failed',
              retry_count = ?,
              error_message = ?,
              completed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(newRetryCount, errorMessage, id);

        logger.error({ id, errorMessage }, 'Task failed permanently');
        return false; // No retry
      }
    });

    return transaction();
  }

  /**
   * Cancel a pending task
   */
  cancel(id: number): void {
    const db = getDatabase();

    db.prepare(`
      UPDATE linear_ticket_queue
      SET status = 'cancelled',
          updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(id);
  }

  /**
   * Cancel all pending tasks for a ticket
   */
  cancelByTicket(ticketId: string): number {
    const db = getDatabase();

    const result = db.prepare(`
      UPDATE linear_ticket_queue
      SET status = 'cancelled',
          updated_at = datetime('now')
      WHERE ticket_id = ? AND status = 'pending'
    `).run(ticketId);

    if (result.changes > 0) {
      logger.info({ ticketId, count: result.changes }, 'Cancelled pending tasks for ticket');
    }

    return result.changes;
  }

  /**
   * Get a task by ID
   */
  getById(id: number): LinearQueueItem | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM linear_ticket_queue WHERE id = ?').get(id) as
      | DbRow
      | undefined;
    return row ? rowToItem(row) : null;
  }

  /**
   * Get all tasks for a ticket
   */
  getByTicket(ticketId: string): LinearQueueItem[] {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT * FROM linear_ticket_queue WHERE ticket_id = ? ORDER BY created_at DESC')
      .all(ticketId) as DbRow[];
    return rows.map(rowToItem);
  }

  /**
   * Get pending task count
   */
  getPendingCount(): number {
    const db = getDatabase();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM linear_ticket_queue WHERE status = 'pending'")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Get processing task count
   */
  getProcessingCount(): number {
    const db = getDatabase();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM linear_ticket_queue WHERE status = 'processing'")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Get queue statistics
   */
  getStats(): Record<TaskStatus, number> {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT status, COUNT(*) as count
        FROM linear_ticket_queue
        GROUP BY status
      `)
      .all() as Array<{ status: string; count: number }>;

    const stats: Record<TaskStatus, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of rows) {
      stats[row.status as TaskStatus] = row.count;
    }

    return stats;
  }

  /**
   * Get all pending items (for inspection)
   */
  listPending(limit = 50): LinearQueueItem[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT * FROM linear_ticket_queue
        WHERE status = 'pending'
        ORDER BY priority ASC, COALESCE(readiness_score, 0) DESC, created_at ASC
        LIMIT ?
      `)
      .all(limit) as DbRow[];
    return rows.map(rowToItem);
  }

  /**
   * Clean up old completed/failed/cancelled tasks
   */
  cleanup(olderThanDays = 7): number {
    const db = getDatabase();
    const result = db.prepare(`
      DELETE FROM linear_ticket_queue
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND updated_at < datetime('now', '-' || ? || ' days')
    `).run(olderThanDays);

    if (result.changes > 0) {
      logger.info({ count: result.changes, olderThanDays }, 'Cleaned up old queue items');
    }

    return result.changes;
  }

  /**
   * Reset stuck processing tasks (e.g., after crash)
   */
  resetStuckTasks(olderThanMinutes = 30): number {
    const db = getDatabase();
    const result = db.prepare(`
      UPDATE linear_ticket_queue
      SET status = 'pending',
          started_at = NULL,
          updated_at = datetime('now')
      WHERE status = 'processing'
        AND started_at < datetime('now', '-' || ? || ' minutes')
    `).run(olderThanMinutes);

    if (result.changes > 0) {
      logger.warn({ count: result.changes }, 'Reset stuck processing tasks');
    }

    return result.changes;
  }

  /**
   * Check if a specific task type is already pending/processing for a ticket
   */
  hasActiveTask(ticketId: string, taskType: LinearTaskType): boolean {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT 1 FROM linear_ticket_queue
      WHERE ticket_id = ?
        AND task_type = ?
        AND status IN ('pending', 'processing')
      LIMIT 1
    `).get(ticketId, taskType);
    return !!row;
  }

  /**
   * Update priority for a ticket's pending tasks
   */
  updatePriority(ticketId: string, priority: Priority, readinessScore?: number): void {
    const db = getDatabase();
    db.prepare(`
      UPDATE linear_ticket_queue
      SET priority = ?,
          readiness_score = COALESCE(?, readiness_score),
          updated_at = datetime('now')
      WHERE ticket_id = ? AND status = 'pending'
    `).run(priority, readinessScore ?? null, ticketId);
  }
}

// Export singleton instance
export const linearQueue = new LinearTicketQueue();
