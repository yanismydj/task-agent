import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { linearClient } from './client.js';
import type { TicketInfo } from './types.js';

const logger = createChildLogger({ module: 'linear-poller' });

export type TicketHandler = (tickets: TicketInfo[]) => Promise<void>;

export class LinearPoller {
  private intervalId: NodeJS.Timeout | null = null;
  private isPolling = false;
  private handler: TicketHandler | null = null;

  setHandler(handler: TicketHandler): void {
    this.handler = handler;
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

  private async poll(): Promise<void> {
    if (this.isPolling) {
      logger.debug('Skipping poll - previous poll still in progress');
      return;
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
      logger.error({ error }, 'Error during poll');
    } finally {
      this.isPolling = false;
    }
  }
}

export const poller = new LinearPoller();
