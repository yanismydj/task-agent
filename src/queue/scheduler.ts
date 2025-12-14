import { createChildLogger } from '../utils/logger.js';
import { linearClient, RateLimitError } from '../linear/client.js';
import { linearCache } from '../linear/cache.js';

const logger = createChildLogger({ module: 'queue-scheduler' });

/**
 * QueueScheduler manages the flow of work from Linear.
 *
 * Design Philosophy (Mention-Triggered Mode):
 * - Webhook-driven: Users trigger actions via @taskAgent mentions
 * - Initial sync: Populate cache on startup for context lookups
 * - No automatic polling: Actions are only triggered by user mentions
 */
export class QueueScheduler {
  private running = false;

  // Track tickets we're waiting for responses on (webhooks will notify us)
  private ticketsAwaitingResponse: Map<string, { ticketId: string; identifier: string; waitingFor: string; lastChecked: Date }> = new Map();

  constructor() {
    // No polling in mention-triggered mode
  }

  /**
   * Start the scheduler
   *
   * In mention-triggered mode, this just does an initial sync to populate the cache.
   * Users must @taskAgent in Linear comments to trigger actions.
   */
  start(): void {
    if (this.running) {
      logger.warn('Scheduler already running');
      return;
    }

    this.running = true;
    logger.info('Starting queue scheduler (mention-triggered mode)');

    // Initial sync to populate cache for context lookups
    setTimeout(() => {
      this.fullSyncWithLinear();
    }, 2000);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.running = false;
    this.ticketsAwaitingResponse.clear();
    logger.info('Queue scheduler stopped');
  }

  /**
   * Full sync with Linear API to populate the cache.
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

      // Also cache tickets to local storage
      for (const ticket of tickets) {
        linearCache.upsertTicket(ticket);
      }

      logger.info(
        { ticketCount: tickets.length },
        'Full sync complete - cache updated'
      );

      return tickets.length;
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
   * Manually trigger a full sync with Linear (useful for testing or on-demand refresh)
   */
  async triggerPoll(): Promise<number> {
    return this.fullSyncWithLinear();
  }
}

export const queueScheduler = new QueueScheduler();
