import http from 'node:http';
import crypto from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config.js';
import {
  isWebhookDeliveryProcessed,
  recordWebhookDelivery,
  markWebhookDeliveryProcessed,
  cleanupOldWebhookDeliveries,
} from '../queue/database.js';

const logger = createChildLogger({ module: 'webhook-server' });

// Linear webhook event types we care about
type WebhookAction = 'create' | 'update' | 'remove';
type WebhookType = 'Issue' | 'Comment' | 'IssueLabel' | 'Project' | 'Reaction';

export interface LinearWebhookPayload {
  action: WebhookAction;
  type: WebhookType;
  data: Record<string, unknown>;
  url: string;
  createdAt: string;
  organizationId: string;
  webhookTimestamp: number;
  webhookId: string;
}

// Issue data from webhook
export interface WebhookIssueData {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  labels?: Array<{ id: string; name: string }>;
  assignee?: { id: string; name: string };
  updatedAt: string;
}

// Comment data from webhook
export interface WebhookCommentData {
  id: string;
  body: string;
  issueId: string;
  userId: string;
  user?: { id: string; name: string; isMe?: boolean };
  createdAt: string;
  updatedAt: string;
}

// Emoji reaction data from webhook
export interface WebhookReactionData {
  id: string;
  emoji: string;
  userId: string;
  user?: { id: string; name: string; isMe?: boolean };
  // Reaction can be on issue or comment
  issueId?: string;
  commentId?: string;
  createdAt: string;
}

export interface WebhookHandlers {
  onIssueUpdate?: (data: WebhookIssueData) => Promise<void>;
  onCommentCreate?: (data: WebhookCommentData) => Promise<void>;
  onCommentUpdate?: (data: WebhookCommentData) => Promise<void>;
  onIssueLabelChange?: (data: Record<string, unknown>) => Promise<void>;
  onReactionCreate?: (data: WebhookReactionData) => Promise<void>;
}

export class WebhookServer {
  private server: http.Server | null = null;
  private port: number;
  private signingSecret: string | null;
  private handlers: WebhookHandlers = {};
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(port?: number, signingSecret?: string) {
    this.port = port ?? config.webhook.port;
    this.signingSecret = signingSecret ?? config.linear.webhookSecret ?? null;
  }

  setHandlers(handlers: WebhookHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Verify the webhook signature from Linear
   * Linear signs webhooks with HMAC SHA-256
   */
  private verifySignature(payload: string, signature: string | undefined): boolean {
    if (!this.signingSecret) {
      // Only allow unsigned webhooks in development mode with explicit flag
      if (config.isDevelopment && config.webhook.allowUnsigned) {
        logger.warn('Allowing unsigned webhook in development mode (WEBHOOK_ALLOW_UNSIGNED=true)');
        return true;
      }
      // In production or without explicit flag, require secret
      logger.error('Webhook signing secret is required. Set LINEAR_WEBHOOK_SECRET or enable WEBHOOK_ALLOW_UNSIGNED for development.');
      return false;
    }

    if (!signature) {
      logger.warn('No signature header in webhook request');
      return false;
    }

    const hmac = crypto.createHmac('sha256', this.signingSecret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');

    // Linear sends signature as: linear-signature: <hex>
    const actualSignature = signature.replace('linear-signature=', '').trim();

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(actualSignature)
    );
  }

  /**
   * Start the webhook server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // Accept POST to /webhook or / (Linear may send to either)
        if (req.method !== 'POST' || !(req.url === '/' || req.url?.startsWith('/webhook'))) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        // Collect body
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));

        req.on('end', async () => {
          const body = Buffer.concat(chunks).toString();
          const signature = req.headers['linear-signature'] as string | undefined;
          const deliveryId = req.headers['linear-delivery'] as string | undefined;

          // Verify signature
          if (!this.verifySignature(body, signature)) {
            logger.warn('Invalid webhook signature');
            res.writeHead(401);
            res.end('Invalid signature');
            return;
          }

          try {
            const payload = JSON.parse(body) as LinearWebhookPayload;

            // Check for duplicate delivery (idempotency)
            const effectiveDeliveryId = deliveryId || payload.webhookId;
            if (effectiveDeliveryId) {
              if (isWebhookDeliveryProcessed(effectiveDeliveryId)) {
                logger.debug({ deliveryId: effectiveDeliveryId }, 'Duplicate webhook delivery, skipping');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: true, duplicate: true }));
                return;
              }

              // Record delivery before processing (even if it might fail, to prevent duplicates)
              const isNew = recordWebhookDelivery(effectiveDeliveryId, payload.type);
              if (!isNew) {
                logger.debug({ deliveryId: effectiveDeliveryId }, 'Webhook delivery already recorded');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: true, duplicate: true }));
                return;
              }
            }

            logger.info(
              {
                type: payload.type,
                action: payload.action,
                webhookId: payload.webhookId,
                deliveryId: effectiveDeliveryId,
              },
              'Received webhook'
            );

            // Process webhook asynchronously
            this.handleWebhook(payload, effectiveDeliveryId).catch((err) => {
              logger.error({ error: err }, 'Error processing webhook');
            });

            // Respond immediately with 200
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
          } catch (error) {
            logger.error({ error, body: body.slice(0, 200) }, 'Failed to parse webhook');
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.port, () => {
        logger.info({ port: this.port }, 'Webhook server started');

        // Start periodic cleanup of old webhook deliveries (every hour)
        this.cleanupInterval = setInterval(() => {
          try {
            const deleted = cleanupOldWebhookDeliveries();
            if (deleted > 0) {
              logger.debug({ deleted }, 'Cleaned up old webhook deliveries');
            }
          } catch (error) {
            logger.error({ error }, 'Failed to cleanup webhook deliveries');
          }
        }, 60 * 60 * 1000); // 1 hour

        resolve();
      });
    });
  }

  /**
   * Stop the webhook server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Stop cleanup interval
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      if (this.server) {
        this.server.close(() => {
          logger.info('Webhook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming webhook based on type and action
   */
  private async handleWebhook(payload: LinearWebhookPayload, deliveryId?: string): Promise<void> {
    const { type, action, data } = payload;

    try {
      switch (type) {
        case 'Issue':
          if (action === 'update' && this.handlers.onIssueUpdate) {
            await this.handlers.onIssueUpdate(data as unknown as WebhookIssueData);
          }
          break;

        case 'Comment':
          if (action === 'create' && this.handlers.onCommentCreate) {
            await this.handlers.onCommentCreate(data as unknown as WebhookCommentData);
          } else if (action === 'update' && this.handlers.onCommentUpdate) {
            await this.handlers.onCommentUpdate(data as unknown as WebhookCommentData);
          }
          break;

        case 'IssueLabel':
          if (this.handlers.onIssueLabelChange) {
            await this.handlers.onIssueLabelChange(data);
          }
          break;

        case 'Reaction':
          if (action === 'create' && this.handlers.onReactionCreate) {
            await this.handlers.onReactionCreate(data as unknown as WebhookReactionData);
          }
          break;

        default:
          logger.debug({ type, action }, 'Unhandled webhook type');
      }

      // Mark delivery as fully processed
      if (deliveryId) {
        markWebhookDeliveryProcessed(deliveryId);
      }
    } catch (error) {
      logger.error({ error, type, action }, 'Error in webhook handler');
      // Still mark as processed to prevent retry loops on persistent errors
      if (deliveryId) {
        markWebhookDeliveryProcessed(deliveryId);
      }
    }
  }

  /**
   * Get the server port (useful after starting)
   */
  getPort(): number {
    return this.port;
  }
}

export const webhookServer = new WebhookServer();
