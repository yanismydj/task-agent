import http from 'node:http';
import crypto from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config.js';

const logger = createChildLogger({ module: 'webhook-server' });

// Linear webhook event types we care about
type WebhookAction = 'create' | 'update' | 'remove';
type WebhookType = 'Issue' | 'Comment' | 'IssueLabel' | 'Project';

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

export interface WebhookHandlers {
  onIssueUpdate?: (data: WebhookIssueData) => Promise<void>;
  onCommentCreate?: (data: WebhookCommentData) => Promise<void>;
  onCommentUpdate?: (data: WebhookCommentData) => Promise<void>;
  onIssueLabelChange?: (data: Record<string, unknown>) => Promise<void>;
}

export class WebhookServer {
  private server: http.Server | null = null;
  private port: number;
  private signingSecret: string | null;
  private handlers: WebhookHandlers = {};

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
      logger.warn('No webhook signing secret configured, skipping verification');
      return true; // Allow if no secret configured (dev mode)
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

          // Verify signature
          if (!this.verifySignature(body, signature)) {
            logger.warn('Invalid webhook signature');
            res.writeHead(401);
            res.end('Invalid signature');
            return;
          }

          try {
            const payload = JSON.parse(body) as LinearWebhookPayload;

            logger.info(
              {
                type: payload.type,
                action: payload.action,
                webhookId: payload.webhookId,
              },
              'Received webhook'
            );

            // Process webhook asynchronously
            this.handleWebhook(payload).catch((err) => {
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
        resolve();
      });
    });
  }

  /**
   * Stop the webhook server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
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
  private async handleWebhook(payload: LinearWebhookPayload): Promise<void> {
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

        default:
          logger.debug({ type, action }, 'Unhandled webhook type');
      }
    } catch (error) {
      logger.error({ error, type, action }, 'Error in webhook handler');
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
