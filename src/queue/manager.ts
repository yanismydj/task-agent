import { initDatabase, closeDatabase, type Priority, type LinearTaskType } from './database.js';
import { linearQueue, type LinearQueueItem } from './linear-queue.js';
import { claudeQueue, type ClaudeQueueItem } from './claude-queue.js';
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config.js';

const logger = createChildLogger({ module: 'queue-manager' });

export interface QueueStats {
  linear: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  claude: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    maxConcurrent: number;
  };
}

export interface TicketToEnqueue {
  ticketId: string;
  ticketIdentifier: string;
  priority: Priority;
  readinessScore?: number;
}

/**
 * QueueManager coordinates the two task queues and provides
 * a high-level API for the workflow engine.
 */
export class QueueManager {
  private initialized = false;

  /**
   * Initialize the queue system
   */
  initialize(dbPath?: string): void {
    if (this.initialized) {
      return;
    }

    initDatabase(dbPath);

    // Configure claude queue concurrency from config
    claudeQueue.setMaxConcurrent(config.agents.maxCodeExecutors);

    // Reset any stuck tasks from previous runs
    linearQueue.resetStuckTasks();
    claudeQueue.resetStuckTasks();

    this.initialized = true;
    logger.info('Queue manager initialized');
  }

  /**
   * Shutdown the queue system
   */
  shutdown(): void {
    closeDatabase();
    this.initialized = false;
    logger.info('Queue manager shutdown');
  }

  // ============================================================
  // Linear Queue Operations
  // ============================================================

  /**
   * Enqueue a ticket for evaluation (first step in pipeline)
   */
  enqueueForEvaluation(ticket: TicketToEnqueue, inputData?: Record<string, unknown>): LinearQueueItem | null {
    return linearQueue.enqueue({
      ...ticket,
      taskType: 'evaluate',
      inputData,
    });
  }

  /**
   * Enqueue a ticket for refinement (asking clarifying questions)
   */
  enqueueForRefinement(ticket: TicketToEnqueue, inputData?: Record<string, unknown>): LinearQueueItem | null {
    return linearQueue.enqueue({
      ...ticket,
      taskType: 'refine',
      inputData,
    });
  }

  /**
   * Enqueue a task to check for human response
   */
  enqueueResponseCheck(ticket: TicketToEnqueue, inputData?: Record<string, unknown>): LinearQueueItem | null {
    return linearQueue.enqueue({
      ...ticket,
      taskType: 'check_response',
      inputData,
      maxRetries: 0, // No retries for response checks
    });
  }

  /**
   * Enqueue a ticket for prompt generation
   */
  enqueueForPromptGeneration(ticket: TicketToEnqueue, inputData?: Record<string, unknown>): LinearQueueItem | null {
    return linearQueue.enqueue({
      ...ticket,
      taskType: 'generate_prompt',
      inputData,
    });
  }

  /**
   * Enqueue a state sync task
   */
  enqueueStateSync(ticket: TicketToEnqueue, inputData?: Record<string, unknown>): LinearQueueItem | null {
    return linearQueue.enqueue({
      ...ticket,
      taskType: 'sync_state',
      inputData,
      maxRetries: 2,
    });
  }

  /**
   * Get the next linear task to process
   */
  dequeueLinearTask(): LinearQueueItem | null {
    return linearQueue.dequeue();
  }

  /**
   * Complete a linear task
   */
  completeLinearTask(id: number, outputData?: Record<string, unknown>): void {
    linearQueue.complete(id, outputData);
  }

  /**
   * Fail a linear task (may retry)
   */
  failLinearTask(id: number, errorMessage: string): boolean {
    return linearQueue.fail(id, errorMessage);
  }

  /**
   * Check if a task type is already active for a ticket
   */
  hasActiveLinearTask(ticketId: string, taskType: LinearTaskType): boolean {
    return linearQueue.hasActiveTask(ticketId, taskType);
  }

  // ============================================================
  // Claude Queue Operations
  // ============================================================

  /**
   * Enqueue a code execution task
   */
  enqueueExecution(params: {
    ticketId: string;
    ticketIdentifier: string;
    priority: Priority;
    readinessScore?: number;
    prompt: string;
    worktreePath: string;
    branchName: string;
    agentSessionId?: string;
  }): ClaudeQueueItem | null {
    return claudeQueue.enqueue(params);
  }

  /**
   * Get the next execution task (respects concurrency limit)
   */
  dequeueExecution(): ClaudeQueueItem | null {
    return claudeQueue.dequeue();
  }

  /**
   * Complete an execution task
   */
  completeExecution(id: number, prUrl?: string): void {
    claudeQueue.complete(id, prUrl);
  }

  /**
   * Fail an execution task (may retry)
   */
  failExecution(id: number, errorMessage: string): boolean {
    return claudeQueue.fail(id, errorMessage);
  }

  /**
   * Check if there's capacity for more executions
   */
  hasExecutionCapacity(): boolean {
    return claudeQueue.hasCapacity();
  }

  /**
   * Check if a ticket already has an active execution
   */
  hasActiveExecution(ticketId: string): boolean {
    return claudeQueue.hasActiveTask(ticketId);
  }

  /**
   * Get active execution for a ticket
   */
  getActiveExecution(ticketId: string): ClaudeQueueItem | null {
    return claudeQueue.getActiveByTicket(ticketId);
  }

  // ============================================================
  // Bulk Operations
  // ============================================================

  /**
   * Enqueue multiple tickets for evaluation (e.g., from initial poll)
   */
  enqueueTicketsForEvaluation(tickets: TicketToEnqueue[]): number {
    let enqueued = 0;
    for (const ticket of tickets) {
      if (!linearQueue.hasActiveTask(ticket.ticketId, 'evaluate')) {
        const item = this.enqueueForEvaluation(ticket);
        if (item) enqueued++;
      }
    }
    return enqueued;
  }

  /**
   * Cancel all tasks for a ticket
   */
  cancelTicket(ticketId: string): void {
    linearQueue.cancelByTicket(ticketId);
    claudeQueue.cancelByTicket(ticketId);
    logger.info({ ticketId }, 'Cancelled all tasks for ticket');
  }

  /**
   * Update priority for all pending tasks of a ticket
   */
  updateTicketPriority(ticketId: string, priority: Priority, readinessScore?: number): void {
    linearQueue.updatePriority(ticketId, priority, readinessScore);
  }

  // ============================================================
  // Statistics & Inspection
  // ============================================================

  /**
   * Get overall queue statistics
   */
  getStats(): QueueStats {
    const linearStats = linearQueue.getStats();
    const claudeStats = claudeQueue.getStats();

    return {
      linear: {
        pending: linearStats.pending,
        processing: linearStats.processing,
        completed: linearStats.completed,
        failed: linearStats.failed,
      },
      claude: {
        pending: claudeStats.byStatus.pending,
        processing: claudeStats.byStatus.processing,
        completed: claudeStats.byStatus.completed,
        failed: claudeStats.byStatus.failed,
        maxConcurrent: claudeStats.maxConcurrent,
      },
    };
  }

  /**
   * Get pending linear tasks (for inspection/debugging)
   */
  listPendingLinearTasks(limit = 50): LinearQueueItem[] {
    return linearQueue.listPending(limit);
  }

  /**
   * Get pending execution tasks
   */
  listPendingExecutions(limit = 50): ClaudeQueueItem[] {
    return claudeQueue.listPending(limit);
  }

  /**
   * Get currently processing executions
   */
  listProcessingExecutions(): ClaudeQueueItem[] {
    return claudeQueue.listProcessing();
  }

  // ============================================================
  // Maintenance
  // ============================================================

  /**
   * Clean up old completed/failed tasks
   */
  cleanup(olderThanDays = 7): { linear: number; claude: number } {
    return {
      linear: linearQueue.cleanup(olderThanDays),
      claude: claudeQueue.cleanup(olderThanDays),
    };
  }

  /**
   * Reset stuck tasks (call on startup)
   */
  resetStuck(): { linear: number; claude: number } {
    return {
      linear: linearQueue.resetStuckTasks(),
      claude: claudeQueue.resetStuckTasks(),
    };
  }
}

// Export singleton instance
export const queueManager = new QueueManager();
