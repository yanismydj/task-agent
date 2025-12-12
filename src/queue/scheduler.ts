import { createChildLogger } from '../utils/logger.js';
import { linearClient, RateLimitError } from '../linear/client.js';
import { linearQueue } from './linear-queue.js';
import { claudeQueue } from './claude-queue.js';
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

// Default intervals - much slower to conserve API calls
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between full polls
const DEFAULT_RESPONSE_CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes for response checks

/**
 * QueueScheduler manages the flow of work from Linear.
 *
 * Design Philosophy:
 * - Slow and steady: We prioritize thoroughness over speed
 * - One ticket at a time: Focus on fully refining each ticket before moving on
 * - Conserve API calls: Poll infrequently, cache ticket data during a work session
 * - Human-paced: Wait for human responses naturally, don't spam checks
 */
export class QueueScheduler {
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private responseCheckInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private responseCheckIntervalMs: number;

  // Track tickets we're waiting for responses on (to avoid re-fetching)
  private ticketsAwaitingResponse: Map<string, { ticketId: string; identifier: string; waitingFor: string; lastChecked: Date }> = new Map();

  // Cache of last fetched tickets to avoid refetching
  private cachedTickets: TicketInfo[] = [];
  private cacheTime: Date | null = null;
  private readonly cacheTtlMs = 2 * 60 * 1000; // Cache valid for 2 minutes

  constructor(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, responseCheckIntervalMs = DEFAULT_RESPONSE_CHECK_INTERVAL_MS) {
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
      {
        pollIntervalMs: this.pollIntervalMs,
        responseCheckIntervalMs: this.responseCheckIntervalMs,
        pollIntervalMinutes: Math.round(this.pollIntervalMs / 60000),
        responseCheckIntervalMinutes: Math.round(this.responseCheckIntervalMs / 60000),
      },
      'Starting queue scheduler (slow mode)'
    );

    // Initial poll after a short delay to let the system settle
    setTimeout(() => {
      this.pollForNewTickets();
    }, 5000);

    // Set up intervals - these are now much slower
    this.pollInterval = setInterval(() => {
      this.pollForNewTickets();
    }, this.pollIntervalMs);

    // Check for responses less frequently
    this.responseCheckInterval = setInterval(() => {
      this.checkForResponses();
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
    this.ticketsAwaitingResponse.clear();
    this.cachedTickets = [];
    this.cacheTime = null;
    logger.info('Queue scheduler stopped');
  }

  /**
   * Get tickets, using cache if available and fresh
   */
  private async getTicketsWithCache(forceRefresh = false): Promise<TicketInfo[]> {
    // Check if cache is valid
    if (!forceRefresh && this.cacheTime && this.cachedTickets.length > 0) {
      const cacheAge = Date.now() - this.cacheTime.getTime();
      if (cacheAge < this.cacheTtlMs) {
        logger.debug({ cacheAgeSeconds: Math.round(cacheAge / 1000) }, 'Using cached tickets');
        return this.cachedTickets;
      }
    }

    // Fetch fresh data
    const tickets = await linearClient.getTickets();
    this.cachedTickets = tickets;
    this.cacheTime = new Date();
    return tickets;
  }

  /**
   * Poll Linear for tickets and enqueue new ones for evaluation.
   * This is now much less frequent and focuses on finding NEW work.
   */
  async pollForNewTickets(): Promise<number> {
    // Skip polling if rate limited
    if (linearClient.isRateLimited()) {
      const resetAt = linearClient.getRateLimitResetAt();
      logger.debug({ resetAt: resetAt?.toLocaleTimeString() }, 'Skipping poll - rate limited');
      return 0;
    }

    // Check if we have active work - if so, skip polling for new tickets
    const pendingCount = linearQueue.getPendingCount();
    const processingCount = linearQueue.getProcessingCount();
    if (pendingCount > 0 || processingCount > 0) {
      logger.debug(
        { pendingCount, processingCount },
        'Skipping poll - already have work queued'
      );
      return 0;
    }

    try {
      logger.info('Polling Linear for new tickets');

      // Force refresh cache on poll
      const tickets = await this.getTicketsWithCache(true);

      let enqueued = 0;

      // Only enqueue ONE new ticket at a time - focus on thoroughness
      for (const ticket of tickets) {
        // Skip if ticket is assigned (manual work)
        if (ticket.assignee) {
          continue;
        }

        // Skip if we already have ANY active task for this ticket
        if (linearQueue.hasAnyActiveTask(ticket.id)) {
          continue;
        }

        // Skip if we just processed this ticket recently (longer cooldown now)
        if (linearQueue.wasRecentlyProcessed(ticket.id, 15)) { // 15 minute cooldown
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

        // Only enqueue ONE ticket per poll cycle - focus on one at a time
        if (enqueued > 0) {
          break;
        }
      }

      if (enqueued > 0) {
        logger.info({ enqueued, totalTickets: tickets.length }, 'Enqueued ticket from poll');
      } else {
        logger.debug({ totalTickets: tickets.length }, 'No new tickets to enqueue');
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
   * Register a ticket that we're waiting for a human response on.
   * This avoids needing to poll Linear to check for responses.
   */
  registerAwaitingResponse(ticketId: string, identifier: string, waitingFor: 'questions' | 'approval'): void {
    this.ticketsAwaitingResponse.set(ticketId, {
      ticketId,
      identifier,
      waitingFor,
      lastChecked: new Date(),
    });
    logger.debug({ ticketId: identifier, waitingFor }, 'Registered ticket awaiting response');
  }

  /**
   * Remove a ticket from the awaiting response list
   */
  clearAwaitingResponse(ticketId: string): void {
    this.ticketsAwaitingResponse.delete(ticketId);
  }

  /**
   * Check for responses on tickets we're waiting for.
   * Only checks tickets we know are waiting, not all tickets.
   */
  private async checkForResponses(): Promise<void> {
    // Skip if rate limited
    if (linearClient.isRateLimited()) {
      return;
    }

    // Skip if no tickets awaiting response
    if (this.ticketsAwaitingResponse.size === 0) {
      logger.debug('No tickets awaiting response');
      return;
    }

    // Skip if we already have work queued
    const pendingCount = linearQueue.getPendingCount();
    if (pendingCount > 0) {
      logger.debug({ pendingCount }, 'Skipping response check - already have work queued');
      return;
    }

    try {
      // Use cached tickets if available, otherwise fetch
      const tickets = await this.getTicketsWithCache();

      // Check each ticket we're waiting on
      for (const [ticketId, awaiting] of this.ticketsAwaitingResponse) {
        // Find the ticket in our list
        const ticket = tickets.find(t => t.id === ticketId);
        if (!ticket) {
          // Ticket no longer in our list - maybe completed or cancelled
          this.ticketsAwaitingResponse.delete(ticketId);
          continue;
        }

        // Check if there's already an active task
        if (linearQueue.hasActiveTask(ticketId, 'check_response')) {
          continue;
        }

        // Only check if enough time has passed since last check (at least 2 minutes)
        const timeSinceLastCheck = Date.now() - awaiting.lastChecked.getTime();
        if (timeSinceLastCheck < 2 * 60 * 1000) {
          continue;
        }

        // Enqueue a response check
        const item = linearQueue.enqueue({
          ticketId: ticket.id,
          ticketIdentifier: ticket.identifier,
          taskType: 'check_response',
          priority: mapPriority(ticket.priority),
          inputData: {
            waitingFor: awaiting.waitingFor,
          },
        });

        if (item) {
          awaiting.lastChecked = new Date();
          logger.info(
            { ticketId: ticket.identifier, waitingFor: awaiting.waitingFor },
            'Enqueued response check'
          );
          // Only check ONE ticket per cycle
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof RateLimitError)) {
        logger.error({ error }, 'Error checking for responses');
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

    // Skip terminal states (completed, failed, blocked)
    if (['ta:completed', 'ta:failed', 'ta:blocked'].includes(taLabel.name)) {
      return 0;
    }

    // For 'task-agent' label (work in progress), check if there's actually a Claude task running
    // If not, the task may have failed and we need to recover
    if (taLabel.name === 'task-agent') {
      if (claudeQueue.hasActiveTask(ticket.id)) {
        // Claude Code is actively working on this - skip
        logger.debug({ ticketId: ticket.identifier }, 'Claude Code is actively working on this ticket');
        return 0;
      }
      // No active Claude task but has task-agent label - this ticket may be stuck
      // Log for debugging but don't auto-recover (manual intervention needed)
      logger.warn(
        { ticketId: ticket.identifier },
        'Ticket has task-agent label but no active Claude task - may be stuck'
      );
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
