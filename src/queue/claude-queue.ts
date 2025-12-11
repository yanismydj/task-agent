import { getDatabase, type TaskStatus, type Priority } from './database.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'claude-queue' });

export interface ClaudeQueueItem {
  id: number;
  ticketId: string;
  ticketIdentifier: string;
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
  prompt: string | null;
  worktreePath: string | null;
  branchName: string | null;
  prUrl: string | null;
  agentSessionId: string | null;
}

interface DbRow {
  id: number;
  ticket_id: string;
  ticket_identifier: string;
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
  prompt: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  pr_url: string | null;
  agent_session_id: string | null;
}

function rowToItem(row: DbRow): ClaudeQueueItem {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    ticketIdentifier: row.ticket_identifier,
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
    prompt: row.prompt,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    prUrl: row.pr_url,
    agentSessionId: row.agent_session_id,
  };
}

export class ClaudeCodeQueue {
  private maxConcurrent: number;

  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Set the maximum concurrent executions
   */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
  }

  /**
   * Add a new code execution task to the queue
   * Uses INSERT OR IGNORE to prevent duplicates (based on ticket_id + status)
   */
  enqueue(params: {
    ticketId: string;
    ticketIdentifier: string;
    priority: Priority;
    readinessScore?: number;
    prompt: string;
    worktreePath: string;
    branchName: string;
    agentSessionId?: string;
    maxRetries?: number;
  }): ClaudeQueueItem | null {
    const db = getDatabase();

    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO claude_code_queue
        (ticket_id, ticket_identifier, priority, readiness_score, prompt, worktree_path, branch_name, agent_session_id, max_retries)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        params.ticketId,
        params.ticketIdentifier,
        params.priority,
        params.readinessScore ?? null,
        params.prompt,
        params.worktreePath,
        params.branchName,
        params.agentSessionId ?? null,
        params.maxRetries ?? 2
      );

      if (result.changes === 0) {
        logger.debug({ ticketId: params.ticketIdentifier }, 'Execution task already in queue');
        return null;
      }

      const item = this.getById(result.lastInsertRowid as number);
      logger.info({ ticketId: params.ticketIdentifier, id: item?.id }, 'Execution task enqueued');
      return item;
    } catch (error) {
      logger.error({ error, params }, 'Failed to enqueue execution task');
      throw error;
    }
  }

  /**
   * Get the next pending task if under concurrency limit
   * Returns null if at max concurrent or no pending tasks
   *
   * Order: priority ASC, readiness DESC, created ASC
   */
  dequeue(): ClaudeQueueItem | null {
    const db = getDatabase();

    const transaction = db.transaction(() => {
      // Check current processing count
      const processingCount = db
        .prepare("SELECT COUNT(*) as count FROM claude_code_queue WHERE status = 'processing'")
        .get() as { count: number };

      if (processingCount.count >= this.maxConcurrent) {
        logger.debug(
          { current: processingCount.count, max: this.maxConcurrent },
          'At max concurrent executions'
        );
        return null;
      }

      // Find next pending item
      const row = db.prepare(`
        SELECT * FROM claude_code_queue
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
        UPDATE claude_code_queue
        SET status = 'processing',
            started_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(row.id);

      // Return updated row
      return db.prepare('SELECT * FROM claude_code_queue WHERE id = ?').get(row.id) as DbRow;
    });

    const result = transaction();

    if (result) {
      const item = rowToItem(result);
      logger.info({ ticketId: item.ticketIdentifier, id: item.id }, 'Execution task dequeued');
      return item;
    }

    return null;
  }

  /**
   * Mark a task as completed with PR URL
   */
  complete(id: number, prUrl?: string): void {
    const db = getDatabase();

    db.prepare(`
      UPDATE claude_code_queue
      SET status = 'completed',
          completed_at = datetime('now'),
          updated_at = datetime('now'),
          pr_url = ?
      WHERE id = ?
    `).run(prUrl ?? null, id);

    logger.info({ id, prUrl }, 'Execution task completed');
  }

  /**
   * Mark a task as failed
   * If retries remain, requeue as pending
   */
  fail(id: number, errorMessage: string): boolean {
    const db = getDatabase();

    const transaction = db.transaction(() => {
      const row = db.prepare('SELECT * FROM claude_code_queue WHERE id = ?').get(id) as
        | DbRow
        | undefined;

      if (!row) {
        return false;
      }

      const newRetryCount = row.retry_count + 1;

      if (newRetryCount < row.max_retries) {
        // Requeue for retry
        db.prepare(`
          UPDATE claude_code_queue
          SET status = 'pending',
              retry_count = ?,
              error_message = ?,
              started_at = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(newRetryCount, errorMessage, id);

        logger.warn(
          { id, retryCount: newRetryCount, maxRetries: row.max_retries },
          'Execution failed, requeued for retry'
        );
        return true; // Will retry
      } else {
        // Max retries exceeded
        db.prepare(`
          UPDATE claude_code_queue
          SET status = 'failed',
              retry_count = ?,
              error_message = ?,
              completed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(newRetryCount, errorMessage, id);

        logger.error({ id, errorMessage }, 'Execution failed permanently');
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
      UPDATE claude_code_queue
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
      UPDATE claude_code_queue
      SET status = 'cancelled',
          updated_at = datetime('now')
      WHERE ticket_id = ? AND status = 'pending'
    `).run(ticketId);

    if (result.changes > 0) {
      logger.info({ ticketId, count: result.changes }, 'Cancelled pending executions for ticket');
    }

    return result.changes;
  }

  /**
   * Get a task by ID
   */
  getById(id: number): ClaudeQueueItem | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM claude_code_queue WHERE id = ?').get(id) as
      | DbRow
      | undefined;
    return row ? rowToItem(row) : null;
  }

  /**
   * Get the active (pending or processing) task for a ticket
   */
  getActiveByTicket(ticketId: string): ClaudeQueueItem | null {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT * FROM claude_code_queue
      WHERE ticket_id = ? AND status IN ('pending', 'processing')
      LIMIT 1
    `).get(ticketId) as DbRow | undefined;
    return row ? rowToItem(row) : null;
  }

  /**
   * Get pending task count
   */
  getPendingCount(): number {
    const db = getDatabase();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM claude_code_queue WHERE status = 'pending'")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Get processing task count
   */
  getProcessingCount(): number {
    const db = getDatabase();
    const row = db
      .prepare("SELECT COUNT(*) as count FROM claude_code_queue WHERE status = 'processing'")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Check if we can accept more tasks
   */
  hasCapacity(): boolean {
    return this.getProcessingCount() < this.maxConcurrent;
  }

  /**
   * Get queue statistics
   */
  getStats(): { byStatus: Record<TaskStatus, number>; processing: number; maxConcurrent: number } {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT status, COUNT(*) as count
        FROM claude_code_queue
        GROUP BY status
      `)
      .all() as Array<{ status: string; count: number }>;

    const byStatus: Record<TaskStatus, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const row of rows) {
      byStatus[row.status as TaskStatus] = row.count;
    }

    return {
      byStatus,
      processing: byStatus.processing,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * Get all pending items (for inspection)
   */
  listPending(limit = 50): ClaudeQueueItem[] {
    const db = getDatabase();
    const rows = db
      .prepare(`
        SELECT * FROM claude_code_queue
        WHERE status = 'pending'
        ORDER BY priority ASC, COALESCE(readiness_score, 0) DESC, created_at ASC
        LIMIT ?
      `)
      .all(limit) as DbRow[];
    return rows.map(rowToItem);
  }

  /**
   * Get all processing items
   */
  listProcessing(): ClaudeQueueItem[] {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT * FROM claude_code_queue WHERE status = 'processing' ORDER BY started_at ASC")
      .all() as DbRow[];
    return rows.map(rowToItem);
  }

  /**
   * Clean up old completed/failed/cancelled tasks
   */
  cleanup(olderThanDays = 7): number {
    const db = getDatabase();
    const result = db.prepare(`
      DELETE FROM claude_code_queue
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND updated_at < datetime('now', '-' || ? || ' days')
    `).run(olderThanDays);

    if (result.changes > 0) {
      logger.info({ count: result.changes, olderThanDays }, 'Cleaned up old execution items');
    }

    return result.changes;
  }

  /**
   * Reset stuck processing tasks (e.g., after crash)
   */
  resetStuckTasks(olderThanMinutes = 60): number {
    const db = getDatabase();
    const result = db.prepare(`
      UPDATE claude_code_queue
      SET status = 'pending',
          started_at = NULL,
          updated_at = datetime('now')
      WHERE status = 'processing'
        AND started_at < datetime('now', '-' || ? || ' minutes')
    `).run(olderThanMinutes);

    if (result.changes > 0) {
      logger.warn({ count: result.changes }, 'Reset stuck execution tasks');
    }

    return result.changes;
  }

  /**
   * Check if a ticket already has a pending/processing execution
   */
  hasActiveTask(ticketId: string): boolean {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT 1 FROM claude_code_queue
      WHERE ticket_id = ?
        AND status IN ('pending', 'processing')
      LIMIT 1
    `).get(ticketId);
    return !!row;
  }

  /**
   * Update the agent session ID for a task
   */
  updateAgentSession(id: number, agentSessionId: string): void {
    const db = getDatabase();
    db.prepare(`
      UPDATE claude_code_queue
      SET agent_session_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(agentSessionId, id);
  }
}

// Export singleton instance
export const claudeQueue = new ClaudeCodeQueue();
