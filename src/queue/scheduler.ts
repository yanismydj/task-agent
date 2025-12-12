import { createChildLogger } from '../utils/logger.js';
import { linearClient, RateLimitError } from '../linear/client.js';
import { linearQueue } from './linear-queue.js';
import type { TicketInfo } from '../linear/types.js';
import type { Priority } from './database.js';

const logger = createChildLogger({ module: 'queue-scheduler' });

// Map Linear priority (0-4) to our priority type
function mapPriority(linearPriority: number): Priority {
  // Linear: 0=no priority, 1=urgent, 2=high, 3=medium, 4=low
  // Our queue uses same values, so direct mapping works
  if (linearPriority >= 0 && linearPriority <= 4) {
    return linearPriority as Priority;
  }
  return 3; // Default to medium
}

/**
 * QueueScheduler periodically fetches tickets from Linear and enqueues
 * them for processing. It replaces the old polling model with a queue-based approach.
 */
export class QueueScheduler {
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private responseCheckInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private responseCheckIntervalMs: number;

  constructor(pollIntervalMs = 60000, responseCheckIntervalMs = 30000) {
    this.pollIntervalMs = pollIntervalMs;
    this.responseCheckIntervalMs = responseCheckIntervalMs;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.running) {
      logger.warn('Scheduler already running');
      return;
    }

    this.running = true;
    logger.info(
      { pollIntervalMs: this.pollIntervalMs, responseCheckIntervalMs: this.responseCheckIntervalMs },
      'Starting queue scheduler'
    );

    // Initial poll
    this.pollForNewTickets();

    // Set up intervals
    this.pollInterval = setInterval(() => {
      this.pollForNewTickets();
    }, this.pollIntervalMs);

    // Check for responses more frequently
    this.responseCheckInterval = setInterval(() => {
      this.reEnqueueResponseChecks();
    }, this.responseCheckIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.responseCheckInterval) {
      clearInterval(this.responseCheckInterval);
      this.responseCheckInterval = null;
    }
    this.running = false;
    logger.info('Queue scheduler stopped');
  }

  /**
   * Poll Linear for tickets and enqueue new ones for evaluation
   */
  async pollForNewTickets(): Promise<number> {
    // Skip polling if rate limited
    if (linearClient.isRateLimited()) {
      const resetAt = linearClient.getRateLimitResetAt();
      logger.debug({ resetAt: resetAt?.toLocaleTimeString() }, 'Skipping poll - rate limited');
      return 0;
    }

    try {
      logger.debug('Polling Linear for tickets');
      const tickets = await linearClient.getTickets();

      let enqueued = 0;
      for (const ticket of tickets) {
        // Skip if ticket is assigned (manual work)
        if (ticket.assignee) {
          continue;
        }

        // Skip if we already have ANY active task for this ticket
        if (linearQueue.hasAnyActiveTask(ticket.id)) {
          continue;
        }

        // Skip if we just processed this ticket recently (prevents rapid re-enqueueing)
        if (linearQueue.wasRecentlyProcessed(ticket.id, 5)) {
          continue;
        }

        // Check for TaskAgent labels to determine state
        const hasTaskAgentLabel = ticket.labels.some(
          (l) => l.name === 'task-agent' || l.name.startsWith('ta:')
        );

        // For tickets with TaskAgent labels, determine what task to enqueue based on label
        if (hasTaskAgentLabel) {
          enqueued += this.enqueueBasedOnLabel(ticket);
        } else {
          // New ticket - enqueue for evaluation
          const item = linearQueue.enqueue({
            ticketId: ticket.id,
            ticketIdentifier: ticket.identifier,
            taskType: 'evaluate',
            priority: mapPriority(ticket.priority),
          });
          if (item) {
            enqueued++;
            logger.info(
              { ticketId: ticket.identifier, priority: ticket.priority },
              'Enqueued ticket for evaluation'
            );
          }
        }
      }

      if (enqueued > 0) {
        logger.info({ enqueued, total: tickets.length }, 'Enqueued tickets from poll');
      }

      return enqueued;
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn({ resetAt: error.resetAt }, 'Rate limited, skipping poll');
      } else {
        logger.error({ error }, 'Error polling for tickets');
      }
      return 0;
    }
  }

  /**
   * Re-enqueue response checks for tickets waiting for human input
   */
  private async reEnqueueResponseChecks(): Promise<void> {
    // Skip if rate limited
    if (linearClient.isRateLimited()) {
      return;
    }

    try {
      const tickets = await linearClient.getTickets();

      for (const ticket of tickets) {
        const waitingLabel = ticket.labels.find(
          (l) => l.name === 'ta:pending-approval' || l.name === 'ta:awaiting-response'
        );

        if (waitingLabel && !linearQueue.hasActiveTask(ticket.id, 'check_response')) {
          linearQueue.enqueue({
            ticketId: ticket.id,
            ticketIdentifier: ticket.identifier,
            taskType: 'check_response',
            priority: mapPriority(ticket.priority),
            inputData: {
              waitingFor: waitingLabel.name === 'ta:pending-approval' ? 'approval' : 'questions',
            },
          });
        }
      }
    } catch (error) {
      if (!(error instanceof RateLimitError)) {
        logger.error({ error }, 'Error re-enqueueing response checks');
      }
    }
  }

  /**
   * Enqueue appropriate task based on ticket's current label state
   */
  private enqueueBasedOnLabel(ticket: TicketInfo): number {
    // Find the TaskAgent label
    const taLabel = ticket.labels.find((l) => l.name.startsWith('ta:') || l.name === 'task-agent');
    if (!taLabel) return 0;

    // Skip terminal states
    if (['ta:completed', 'ta:failed', 'ta:blocked', 'task-agent'].includes(taLabel.name)) {
      return 0;
    }

    const labelToTaskType: Record<string, { taskType: 'evaluate' | 'refine' | 'check_response' | 'generate_prompt'; inputData?: Record<string, unknown>; priorityBoost?: number }> = {
      'ta:evaluating': { taskType: 'evaluate' },
      'ta:needs-refinement': { taskType: 'refine' },
      'ta:refining': { taskType: 'refine' },
      // Response checks get priority boost - we want to maintain conversation flow
      'ta:awaiting-response': { taskType: 'check_response', inputData: { waitingFor: 'questions' }, priorityBoost: -1 },
      'ta:pending-approval': { taskType: 'check_response', inputData: { waitingFor: 'approval' }, priorityBoost: -1 },
      'ta:approved': { taskType: 'generate_prompt' },
      'ta:generating-prompt': { taskType: 'generate_prompt' },
    };

    const mapping = labelToTaskType[taLabel.name];
    if (!mapping) return 0;

    // Check if we already have this task
    if (linearQueue.hasActiveTask(ticket.id, mapping.taskType)) {
      return 0;
    }

    // Calculate priority with optional boost (lower number = higher priority)
    let priority = mapPriority(ticket.priority);
    if (mapping.priorityBoost) {
      priority = Math.max(1, Math.min(4, priority + mapping.priorityBoost)) as Priority;
    }

    const item = linearQueue.enqueue({
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      taskType: mapping.taskType,
      priority,
      inputData: mapping.inputData,
    });

    if (item) {
      logger.debug(
        { ticketId: ticket.identifier, taskType: mapping.taskType, label: taLabel.name },
        'Enqueued task based on label'
      );
      return 1;
    }

    return 0;
  }

  /**
   * Manually trigger a poll (useful for testing or on-demand refresh)
   */
  async triggerPoll(): Promise<number> {
    return this.pollForNewTickets();
  }
}

export const queueScheduler = new QueueScheduler();
