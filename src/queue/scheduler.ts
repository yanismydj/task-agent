import { createChildLogger } from '../utils/logger.js';
import { linearClient, RateLimitError } from '../linear/client.js';
import { linearCache } from '../linear/cache.js';
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

// Default intervals - optimized for webhook-driven workflow
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000; // 5 seconds - check LOCAL cache for new work
const DEFAULT_FULL_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - full sync with Linear API

/**
 * QueueScheduler manages the flow of work from Linear.
 *
 * Design Philosophy (Optimized for Webhooks):
 * - Local-first: Use SQLite cache for fast ticket lookups
 * - Webhook-driven: Webhooks handle real-time updates, scheduler checks cache frequently
 * - Periodic sync: Full API sync every 5 minutes for consistency
 * - One ticket at a time: Focus on fully refining each ticket before moving on
 */
export class QueueScheduler {
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private fullSyncInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private fullSyncIntervalMs: number;

  // Track tickets we're waiting for responses on (webhooks will notify us)
  private ticketsAwaitingResponse: Map<string, { ticketId: string; identifier: string; waitingFor: string; lastChecked: Date }> = new Map();

  constructor(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, fullSyncIntervalMs = DEFAULT_FULL_SYNC_INTERVAL_MS) {
    this.pollIntervalMs = pollIntervalMs;
    this.fullSyncIntervalMs = fullSyncIntervalMs;
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
        fullSyncIntervalMs: this.fullSyncIntervalMs,
        pollIntervalSeconds: Math.round(this.pollIntervalMs / 1000),
        fullSyncIntervalMinutes: Math.round(this.fullSyncIntervalMs / 60000),
      },
      'Starting queue scheduler (webhook-optimized mode)'
    );

    // Initial full sync after a short delay to populate cache
    setTimeout(() => {
      this.fullSyncWithLinear();
    }, 2000);

    // Fast local poll - checks SQLite cache for new work (no API calls)
    this.pollInterval = setInterval(() => {
      this.pollLocalCache();
    }, this.pollIntervalMs);

    // Periodic full sync with Linear API for consistency
    this.fullSyncInterval = setInterval(() => {
      this.fullSyncWithLinear();
    }, this.fullSyncIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.fullSyncInterval) {
      clearInterval(this.fullSyncInterval);
      this.fullSyncInterval = null;
    }
    this.running = false;
    this.ticketsAwaitingResponse.clear();
    logger.info('Queue scheduler stopped');
  }

  /**
   * Poll local SQLite cache for tickets that need work.
   * This is fast (no API calls) and runs frequently.
   * Webhooks update the cache, so we just need to check for actionable tickets.
   */
  pollLocalCache(): number {
    // NOTE: We removed the global pending/processing check that used to skip ALL polling.
    // That was causing tickets to get stuck - if one ticket had a slow/stuck task,
    // ALL other tickets were blocked from being picked up.
    // Now we check per-ticket in the loop below instead.

    // Get tickets from local SQLite cache (no API call!)
    const tickets = linearCache.getTickets();

    if (tickets.length === 0) {
      logger.debug('No tickets in local cache');
      return 0;
    }

    let enqueued = 0;

    // Only enqueue ONE new ticket at a time - focus on thoroughness
    for (const ticket of tickets) {
      // Skip completed/canceled tickets
      if (ticket.state.type === 'completed' || ticket.state.type === 'canceled') {
        continue;
      }

      // Skip if ticket is assigned (manual work)
      if (ticket.assignee) {
        continue;
      }

      // Skip if we already have ANY active task for this ticket
      if (linearQueue.hasAnyActiveTask(ticket.id)) {
        continue;
      }

      // Skip if we just processed this ticket recently
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
            'Enqueued ticket for evaluation (from cache)'
          );
        }
      }

      // Only enqueue ONE ticket per poll cycle - focus on one at a time
      if (enqueued > 0) {
        break;
      }
    }

    if (enqueued > 0) {
      logger.debug({ enqueued, cacheSize: tickets.length }, 'Enqueued ticket from local cache');
    }

    return enqueued;
  }

  /**
   * Full sync with Linear API for consistency.
   * This runs less frequently (every 5 minutes) to catch any missed updates.
   */
  async fullSyncWithLinear(): Promise<number> {
    // Skip if rate limited
    if (linearClient.isRateLimited()) {
      const resetAt = linearClient.getRateLimitResetAt();
      logger.debug({ resetAt: resetAt?.toLocaleTimeString() }, 'Skipping full sync - rate limited');
      return 0;
    }

    try {
      logger.info('Starting full sync with Linear API');

      // Fetch all tickets from Linear (this updates the cache automatically)
      const tickets = await linearClient.getTickets();

      logger.info(
        { ticketCount: tickets.length },
        'Full sync complete - cache updated'
      );

      // After sync, poll local cache to find work
      return this.pollLocalCache();
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn({ resetAt: error.resetAt }, 'Rate limited during full sync');
      } else {
        logger.error({ error }, 'Error during full sync with Linear');
      }
      return 0;
    }
  }

  /**
   * Legacy method for compatibility - now uses local cache poll
   * @deprecated Use pollLocalCache() or fullSyncWithLinear() instead
   */
  async pollForNewTickets(): Promise<number> {
    return this.pollLocalCache();
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
   * Check if a ticket is awaiting a response
   */
  isAwaitingResponse(ticketId: string): boolean {
    return this.ticketsAwaitingResponse.has(ticketId);
  }

  /**
   * Get what type of response a ticket is awaiting
   */
  getAwaitingResponseType(ticketId: string): 'questions' | 'approval' | null {
    const awaiting = this.ticketsAwaitingResponse.get(ticketId);
    if (!awaiting) return null;
    return awaiting.waitingFor as 'questions' | 'approval';
  }

  /**
   * Enqueue appropriate task based on ticket's current label state
   */
  private enqueueBasedOnLabel(ticket: TicketInfo): number {
    // Find the TaskAgent label
    const taLabel = ticket.labels.find((l) => l.name.startsWith('ta:') || l.name === 'task-agent');
    if (!taLabel) {
      logger.debug({ ticketId: ticket.identifier }, 'No TaskAgent label found');
      return 0;
    }

    // Skip terminal states (completed, failed, blocked)
    if (['ta:completed', 'ta:failed', 'ta:blocked'].includes(taLabel.name)) {
      logger.debug({ ticketId: ticket.identifier, label: taLabel.name }, 'Skipping terminal state');
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
      // Don't spam logs - just skip quietly (debug level only)
      logger.debug(
        { ticketId: ticket.identifier },
        'Ticket has task-agent label but no active Claude task - skipping'
      );
      return 0;
    }

    const labelToTaskType: Record<string, { taskType: 'evaluate' | 'refine' | 'generate_prompt'; inputData?: Record<string, unknown>; priorityBoost?: number }> = {
      'ta:evaluating': { taskType: 'evaluate' },
      'ta:needs-refinement': { taskType: 'refine' },
      'ta:refining': { taskType: 'refine' },
      // Awaiting response states - fallback for when webhooks miss the response
      // Always re-evaluate to check if new info came in (readiness is the source of truth)
      'ta:awaiting-response': { taskType: 'evaluate', priorityBoost: 1 },
      'ta:pending-approval': { taskType: 'evaluate', priorityBoost: 1 },
      'ta:approved': { taskType: 'generate_prompt' },
      'ta:generating-prompt': { taskType: 'generate_prompt' },
    };

    const mapping = labelToTaskType[taLabel.name];
    if (!mapping) {
      logger.debug({ ticketId: ticket.identifier, label: taLabel.name }, 'No mapping for label');
      return 0;
    }

    // Check if we already have this task
    if (linearQueue.hasActiveTask(ticket.id, mapping.taskType)) {
      logger.debug({ ticketId: ticket.identifier, taskType: mapping.taskType }, 'Already have active task');
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
   * Manually trigger a full sync with Linear (useful for testing or on-demand refresh)
   */
  async triggerPoll(): Promise<number> {
    return this.fullSyncWithLinear();
  }

  /**
   * Manually trigger a local cache poll (faster, no API call)
   */
  triggerLocalPoll(): number {
    return this.pollLocalCache();
  }
}

export const queueScheduler = new QueueScheduler();
