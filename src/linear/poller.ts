import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { linearClient, RateLimitError } from './client.js';
import type { TicketInfo } from './types.js';

const logger = createChildLogger({ module: 'linear-poller' });

export type TicketHandler = (tickets: TicketInfo[]) => Promise<void>;
export type RateLimitHandler = (resetAt: Date) => void;

export class LinearPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private isPolling = false;
  private handler: TicketHandler | null = null;
  private rateLimitHandler: RateLimitHandler | null = null;
  private lastRateLimitMessage: string | null = null;

  setHandler(handler: TicketHandler): void {
    this.handler = handler;
  }

  setRateLimitHandler(handler: RateLimitHandler): void {
    this.rateLimitHandler = handler;
  }

  start(): void {
    if (this.intervalId) {
      logger.warn('Poller already running');
      return;
    }

    const intervalMs = config.daemon.pollIntervalSeconds * 1000;
    logger.info({ intervalMs }, 'Starting Linear poller');

    this.poll();

    this.intervalId = setInterval(() => {
      this.poll();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped Linear poller');
    }
  }

  private formatResetTime(resetAt: Date): string {
    const hours = resetAt.getHours().toString().padStart(2, '0');
    const minutes = resetAt.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  private async poll(): Promise<void> {
    if (this.isPolling) {
      logger.debug('Skipping poll - previous poll still in progress');
      return;
    }

    // Check if we're rate limited before even trying
    if (linearClient.isRateLimited()) {
      const resetAt = linearClient.getRateLimitResetAt();
      if (resetAt) {
        const message = `Linear rate limit hit - paused until ${this.formatResetTime(resetAt)}`;
        // Only log once per rate limit period
        if (this.lastRateLimitMessage !== message) {
          this.lastRateLimitMessage = message;
          logger.warn({ resetAt: this.formatResetTime(resetAt) }, message);
          if (this.rateLimitHandler) {
            this.rateLimitHandler(resetAt);
          }
        }
      }
      return;
    }

    // Clear rate limit message when we're no longer rate limited
    if (this.lastRateLimitMessage) {
      this.lastRateLimitMessage = null;
      logger.info('Rate limit cleared, resuming polling');
    }

    this.isPolling = true;

    try {
      logger.debug('Polling Linear for tickets');
      const tickets = await linearClient.getTickets();
      logger.debug({ count: tickets.length }, 'Retrieved tickets');

      if (this.handler) {
        await this.handler(tickets);
      }
    } catch (error) {
      if (error instanceof RateLimitError) {
        const message = `Linear rate limit hit - paused until ${this.formatResetTime(error.resetAt)}`;
        if (this.lastRateLimitMessage !== message) {
          this.lastRateLimitMessage = message;
          logger.warn({ resetAt: this.formatResetTime(error.resetAt) }, message);
          if (this.rateLimitHandler) {
            this.rateLimitHandler(error.resetAt);
          }
        }
      } else {
        logger.error({ error }, 'Error during poll');
      }
    } finally {
      this.isPolling = false;
    }
  }
}

export const poller = new LinearPoller();
