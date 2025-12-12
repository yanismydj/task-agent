import {
  LinearClient,
  Issue,
  Comment,
  RateLimitPayload,
  AgentSession,
} from '@linear/sdk';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { initializeAuth, getAuth } from './auth.js';
import type { TicketInfo, TicketComment, TicketUpdate, ProjectLead } from './types.js';

const logger = createChildLogger({ module: 'linear-client' });

export interface RateLimitInfo {
  requestsRemaining: number;
  requestsAllowed: number;
  complexityRemaining: number;
  complexityAllowed: number;
  resetAt: Date;
}

export class RateLimitError extends Error {
  constructor(
    public readonly resetAt: Date,
    public readonly rateLimitInfo?: RateLimitInfo,
    message?: string
  ) {
    super(message || `Rate limited until ${resetAt.toLocaleTimeString()}`);
    this.name = 'RateLimitError';
  }
}

// Rate limit constants based on Linear documentation
// https://linear.app/developers/rate-limiting
const REQUESTS_PER_HOUR = 1500;
const COMPLEXITY_PER_HOUR = 250000;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;
const MAX_RETRIES = 3;

export class LinearApiClient {
  private client: LinearClient | null = null;
  private teamId: string;
  private projectId?: string;
  private useOAuth: boolean;
  private rateLimitResetAt: Date | null = null;
  private lastRateLimitInfo: RateLimitInfo | null = null;
  private consecutiveErrors = 0;

  constructor() {
    this.teamId = config.linear.teamId;
    this.projectId = config.linear.projectId;
    this.useOAuth = config.linear.auth.mode === 'oauth';

    if (config.linear.auth.mode === 'apikey') {
      // Legacy mode: use API key directly
      this.client = new LinearClient({ apiKey: config.linear.auth.apiKey });
      logger.info('Using Linear API key authentication (legacy mode)');
    } else {
      // OAuth mode: initialize auth module
      initializeAuth({
        clientId: config.linear.auth.clientId,
        clientSecret: config.linear.auth.clientSecret,
      });
      logger.info('Using Linear OAuth authentication (agent mode)');
    }
  }

  private async getClient(): Promise<LinearClient> {
    if (this.client) {
      return this.client;
    }

    // OAuth mode: get access token and create client
    const auth = getAuth();
    const accessToken = await auth.getAccessToken();
    this.client = new LinearClient({ accessToken });
    return this.client;
  }

  /**
   * Check if we're currently rate limited
   */
  isRateLimited(): boolean {
    if (!this.rateLimitResetAt) return false;
    return new Date() < this.rateLimitResetAt;
  }

  /**
   * Get the time when rate limit resets (null if not rate limited)
   */
  getRateLimitResetAt(): Date | null {
    if (!this.isRateLimited()) {
      this.rateLimitResetAt = null;
      return null;
    }
    return this.rateLimitResetAt;
  }

  /**
   * Get the last known rate limit info
   */
  getRateLimitInfo(): RateLimitInfo | null {
    return this.lastRateLimitInfo;
  }

  /**
   * Query the current rate limit status from Linear API
   * Returns null if query fails (don't make API calls when already rate limited)
   */
  async queryRateLimitStatus(): Promise<RateLimitInfo | null> {
    // Don't query if we're already rate limited
    if (this.isRateLimited()) {
      return this.lastRateLimitInfo;
    }

    try {
      const client = await this.getClient();
      const status: RateLimitPayload = await client.rateLimitStatus;
      const info = this.parseRateLimitPayload(status);
      this.lastRateLimitInfo = info;

      // If we're low on quota, proactively set rate limit
      if (info.requestsRemaining < 50 || info.complexityRemaining < 5000) {
        logger.warn(
          { requestsRemaining: info.requestsRemaining, complexityRemaining: info.complexityRemaining },
          'Rate limit quota low, pausing until reset'
        );
        this.rateLimitResetAt = info.resetAt;
      }

      return info;
    } catch (error) {
      // If this fails, it might be because we're rate limited
      // Set a conservative backoff
      const errorStr = String(error);
      if (errorStr.includes('Rate limit') || errorStr.includes('RATELIMITED')) {
        this.rateLimitResetAt = new Date(Date.now() + 5 * 60 * 1000);
        logger.warn({ resetAt: this.rateLimitResetAt.toLocaleTimeString() }, 'Rate limited when checking status');
      }
      return null;
    }
  }

  /**
   * Check rate limit status on startup and return seconds to wait (0 if ok)
   */
  async checkStartupRateLimit(): Promise<number> {
    const info = await this.queryRateLimitStatus();
    if (!info) {
      // Couldn't query - if we're rate limited, return wait time
      if (this.rateLimitResetAt) {
        const waitMs = this.rateLimitResetAt.getTime() - Date.now();
        return Math.max(0, Math.ceil(waitMs / 1000));
      }
      return 0;
    }

    // If low on quota, return time until reset
    if (info.requestsRemaining < 50 || info.complexityRemaining < 5000) {
      const waitMs = info.resetAt.getTime() - Date.now();
      return Math.max(0, Math.ceil(waitMs / 1000));
    }

    logger.info(
      { requestsRemaining: info.requestsRemaining, complexityRemaining: info.complexityRemaining },
      'Rate limit status OK'
    );
    return 0;
  }

  /**
   * Parse RateLimitPayload from SDK into our RateLimitInfo format
   */
  private parseRateLimitPayload(payload: RateLimitPayload): RateLimitInfo {
    let requestsRemaining = REQUESTS_PER_HOUR;
    let requestsAllowed = REQUESTS_PER_HOUR;
    let complexityRemaining = COMPLEXITY_PER_HOUR;
    let complexityAllowed = COMPLEXITY_PER_HOUR;
    let resetAt = new Date(Date.now() + 3600000); // Default to 1 hour

    for (const limit of payload.limits) {
      if (limit.type === 'requestLimit') {
        requestsRemaining = limit.remainingAmount;
        requestsAllowed = limit.allowedAmount;
        resetAt = new Date(limit.reset);
      } else if (limit.type === 'complexityLimit') {
        complexityRemaining = limit.remainingAmount;
        complexityAllowed = limit.allowedAmount;
        // Use earliest reset time
        const complexityReset = new Date(limit.reset);
        if (complexityReset < resetAt) {
          resetAt = complexityReset;
        }
      }
    }

    return {
      requestsRemaining,
      requestsAllowed,
      complexityRemaining,
      complexityAllowed,
      resetAt,
    };
  }

  /**
   * Check if an error is a rate limit error and extract reset time
   */
  private extractRateLimitFromError(error: unknown): Date | null {
    if (!(error instanceof Error)) return null;

    const errorStr = String(error);

    // Check for rate limit error patterns from Linear API
    // Linear returns errors with code "RATELIMITED"
    if (!errorStr.includes('Rate limit exceeded') && !errorStr.includes('RATELIMITED')) {
      return null;
    }

    // Try to extract reset time from error message
    // Linear errors may include: "reset in X seconds" or similar
    const resetMatch = errorStr.match(/reset(?:s)?\s+(?:in\s+)?(\d+)\s*(?:seconds?|s)/i);
    if (resetMatch && resetMatch[1]) {
      const seconds = parseInt(resetMatch[1], 10);
      return new Date(Date.now() + seconds * 1000);
    }

    // Fallback: Linear rate limit is 1 hour (leaky bucket refills over 1 hour)
    // But use a shorter backoff (5 minutes) to avoid waiting too long
    return new Date(Date.now() + 5 * 60 * 1000);
  }

  /**
   * Calculate exponential backoff delay with jitter
   * Based on Linear's recommendation for handling rate limits
   */
  private calculateBackoffDelay(attempt: number): number {
    // Exponential backoff: base * 2^attempt
    const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
    // Cap at maximum delay
    const cappedDelay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
    // Add jitter (±25% randomization) to prevent thundering herd
    const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wrap API calls with retry logic, rate limit handling, and exponential backoff.
   * Implements Linear rate limiting best practices:
   * - Checks rate limit status before making calls
   * - Retries with exponential backoff + jitter on transient errors
   * - Properly handles RATELIMITED errors from Linear API
   * - Refreshes OAuth tokens on 401 errors
   */
  private async withRetry<T>(operation: (client: LinearClient) => Promise<T>): Promise<T> {
    // Check if we're rate limited before making the call
    if (this.isRateLimited()) {
      throw new RateLimitError(this.rateLimitResetAt!, this.lastRateLimitInfo ?? undefined);
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const client = await this.getClient();
        const result = await operation(client);

        // Success - reset consecutive error counter
        this.consecutiveErrors = 0;
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's a rate limit error
        const resetAt = this.extractRateLimitFromError(error);
        if (resetAt) {
          this.rateLimitResetAt = resetAt;
          this.consecutiveErrors++;

          // Don't make additional API calls when rate limited - just use the extracted info
          logger.warn(
            {
              resetAt: this.rateLimitResetAt.toLocaleTimeString(),
              consecutiveErrors: this.consecutiveErrors,
            },
            'Linear rate limit hit'
          );
          throw new RateLimitError(this.rateLimitResetAt, this.lastRateLimitInfo ?? undefined);
        }

        // Check if it's a 401 error and we're using OAuth
        if (this.useOAuth && lastError.message.includes('401')) {
          logger.info('Got 401, refreshing OAuth token');
          const auth = getAuth();
          auth.invalidateToken();
          this.client = null; // Force client recreation
          // Retry immediately after token refresh (don't count as retry attempt)
          continue;
        }

        // Check if it's a transient error that should be retried
        const isTransient = this.isTransientError(lastError);

        if (isTransient && attempt < MAX_RETRIES) {
          const delay = this.calculateBackoffDelay(attempt);
          logger.warn(
            {
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              delayMs: delay,
              error: lastError.message,
            },
            'Transient error, retrying with backoff'
          );
          await this.sleep(delay);
          continue;
        }

        // Non-transient error or max retries exceeded
        break;
      }
    }

    // All retries exhausted
    this.consecutiveErrors++;
    throw lastError;
  }

  /**
   * Determine if an error is transient and should be retried
   */
  private isTransientError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('504')
    );
  }

  async getTickets(): Promise<TicketInfo[]> {
    logger.debug('Fetching tickets from Linear');

    const filter: Record<string, unknown> = {
      team: { id: { eq: this.teamId } },
      state: { type: { nin: ['completed', 'canceled'] } },
    };

    if (this.projectId) {
      filter['project'] = { id: { eq: this.projectId } };
    }

    return this.withRetry(async (client) => {
      const issues = await client.issues({ filter });

      const tickets: TicketInfo[] = [];
      for (const issue of issues.nodes) {
        const ticket = await this.mapIssueToTicket(issue);
        tickets.push(ticket);
      }

      logger.info({ count: tickets.length }, 'Fetched tickets from Linear');
      return tickets;
    });
  }

  async getTicket(issueId: string): Promise<TicketInfo | null> {
    try {
      return this.withRetry(async (client) => {
        const issue = await client.issue(issueId);
        return this.mapIssueToTicket(issue);
      });
    } catch (error) {
      logger.error({ issueId, error }, 'Failed to fetch ticket');
      return null;
    }
  }

  async getComments(issueId: string): Promise<TicketComment[]> {
    return this.withRetry(async (client) => {
      const issue = await client.issue(issueId);
      const comments = await issue.comments();
      const me = await client.viewer;

      return Promise.all(
        comments.nodes.map(async (comment: Comment) => {
          const user = await comment.user;
          return {
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
            user: user
              ? {
                  id: user.id,
                  name: user.name,
                  isMe: user.id === me.id,
                }
              : null,
          };
        })
      );
    });
  }

  async addComment(issueId: string, body: string): Promise<void> {
    logger.debug({ issueId }, 'Adding comment to ticket');
    await this.withRetry(async (client) => {
      await client.createComment({ issueId, body });
    });
    logger.info({ issueId }, 'Added comment to ticket');
  }

  async updateTicket(issueId: string, update: TicketUpdate): Promise<void> {
    logger.debug({ issueId, update }, 'Updating ticket');
    await this.withRetry(async (client) => {
      await client.updateIssue(issueId, {
        stateId: update.stateId,
        assigneeId: update.assigneeId,
        labelIds: update.labelIds,
      });
    });
    logger.info({ issueId }, 'Updated ticket');
  }

  /**
   * Update the ticket description with consolidated requirements
   */
  async updateDescription(issueId: string, description: string): Promise<void> {
    logger.debug({ issueId, descriptionLength: description.length }, 'Updating ticket description');
    await this.withRetry(async (client) => {
      await client.updateIssue(issueId, { description });
    });
    logger.info({ issueId }, 'Updated ticket description');
  }

  async addLabel(issueId: string, labelName: string): Promise<void> {
    await this.withRetry(async (client) => {
      const issue = await client.issue(issueId);
      const labels = await issue.labels();
      const team = await client.team(this.teamId);
      const teamLabels = await team.labels();

      let label = teamLabels.nodes.find((l) => l.name === labelName);
      if (!label) {
        const result = await client.createIssueLabel({
          teamId: this.teamId,
          name: labelName,
        });
        const createdLabel = await result.issueLabel;
        if (!createdLabel) {
          throw new Error(`Failed to create label: ${labelName}`);
        }
        label = createdLabel;
      }

      const existingLabelIds = labels.nodes.map((l) => l.id);
      if (!existingLabelIds.includes(label.id)) {
        await client.updateIssue(issueId, {
          labelIds: [...existingLabelIds, label.id],
        });
        logger.info({ issueId, labelName }, 'Added label to ticket');
      }
    });
  }

  async removeLabel(issueId: string, labelName: string): Promise<void> {
    await this.withRetry(async (client) => {
      const issue = await client.issue(issueId);
      const labels = await issue.labels();

      const labelToRemove = labels.nodes.find((l) => l.name === labelName);
      if (labelToRemove) {
        const newLabelIds = labels.nodes.filter((l) => l.id !== labelToRemove.id).map((l) => l.id);
        await client.updateIssue(issueId, { labelIds: newLabelIds });
        logger.info({ issueId, labelName }, 'Removed label from ticket');
      }
    });
  }

  /**
   * Get the project lead for a given project ID
   * Returns null if no project ID is configured or no lead is set
   */
  async getProjectLead(projectId?: string): Promise<ProjectLead | null> {
    const targetProjectId = projectId || this.projectId;
    if (!targetProjectId) {
      return null;
    }

    return this.withRetry(async (client) => {
      const project = await client.project(targetProjectId);
      if (!project) {
        return null;
      }

      const lead = await project.lead;
      if (!lead) {
        logger.debug({ projectId: targetProjectId }, 'Project has no lead set');
        return null;
      }

      return {
        id: lead.id,
        name: lead.name,
        displayName: lead.displayName,
        url: lead.url,
      };
    });
  }

  /**
   * Format a user mention for use in comments
   * Linear mentions work by including the user's profile URL in the text
   */
  formatUserMention(user: ProjectLead): string {
    return user.url;
  }

  // ============================================================
  // Issue State Management
  // ============================================================

  /**
   * Get workflow states for the team
   */
  async getWorkflowStates(): Promise<Array<{ id: string; name: string; type: string }>> {
    return this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const states = await team.states();
      return states.nodes.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      }));
    });
  }

  /**
   * Set issue state to "In Progress" (or equivalent started state)
   */
  async setIssueInProgress(issueId: string): Promise<void> {
    await this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const states = await team.states();

      // Find "In Progress" state or equivalent (type: 'started')
      const inProgressState = states.nodes.find(
        (s) => s.name.toLowerCase() === 'in progress' || s.type === 'started'
      );

      if (inProgressState) {
        await client.updateIssue(issueId, { stateId: inProgressState.id });
        logger.info({ issueId, stateName: inProgressState.name }, 'Set issue to In Progress');
      } else {
        logger.warn({ issueId }, 'No "In Progress" state found for team');
      }
    });
  }

  /**
   * Set issue state to "Done" (or equivalent completed state)
   */
  async setIssueDone(issueId: string): Promise<void> {
    await this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const states = await team.states();

      // Find "Done" state or equivalent (type: 'completed')
      const doneState = states.nodes.find(
        (s) => s.name.toLowerCase() === 'done' || s.type === 'completed'
      );

      if (doneState) {
        await client.updateIssue(issueId, { stateId: doneState.id });
        logger.info({ issueId, stateName: doneState.name }, 'Set issue to Done');
      } else {
        logger.warn({ issueId }, 'No "Done" state found for team');
      }
    });
  }

  // ============================================================
  // Agent Session Support (Linear Agents API)
  // https://linear.app/developers/agents
  // ============================================================

  /**
   * Create an agent session for an issue
   * This creates a tracked session that shows up in Linear's UI
   */
  async createAgentSession(issueId: string, externalLink?: string): Promise<AgentSession | null> {
    try {
      return await this.withRetry(async (client) => {
        const payload = await client.agentSessionCreateOnIssue({
          issueId,
          externalLink,
        });
        const session = await payload.agentSession;
        if (session) {
          logger.info({ issueId, sessionId: session.id }, 'Created agent session');
        }
        return session ?? null;
      });
    } catch (error) {
      // Agent sessions may not be available if not using actor=app OAuth mode
      logger.debug({ issueId, error }, 'Failed to create agent session (may require actor=app OAuth)');
      return null;
    }
  }

  /**
   * Update an agent session's external link
   * Note: Status updates happen implicitly through activities in Linear's agent model
   */
  async updateAgentSessionExternalUrl(
    sessionId: string,
    externalLink: string
  ): Promise<void> {
    try {
      await this.withRetry(async (client) => {
        await client.agentSessionUpdateExternalUrl(sessionId, { externalLink });
        logger.debug({ sessionId, externalLink }, 'Updated agent session external URL');
      });
    } catch (error) {
      logger.debug({ sessionId, error }, 'Failed to update agent session external URL');
    }
  }

  /**
   * Add an activity to an agent session
   * Activities provide real-time visibility into what the agent is doing
   * See: https://linear.app/developers/agent-interaction#activity-content-payload
   */
  async addAgentActivity(
    sessionId: string,
    type: 'thought' | 'action' | 'response' | 'error',
    content: {
      message?: string;
      action?: string;
      parameter?: string;
      result?: string;
    },
    options?: {
      ephemeral?: boolean;
    }
  ): Promise<void> {
    try {
      await this.withRetry(async (client) => {
        // Build content payload based on activity type
        // See https://linear.app/developers/agent-interaction#activity-content-payload
        const contentPayload: Record<string, unknown> = { type };

        if (type === 'thought' && content.message) {
          contentPayload.message = content.message;
        } else if (type === 'action') {
          contentPayload.action = content.action || 'processing';
          contentPayload.parameter = content.parameter || '';
          if (content.result) {
            contentPayload.result = content.result;
          }
        } else if (type === 'response' && content.message) {
          contentPayload.message = content.message;
        } else if (type === 'error' && content.message) {
          contentPayload.message = content.message;
        }

        await client.createAgentActivity({
          agentSessionId: sessionId,
          content: contentPayload,
          ephemeral: options?.ephemeral,
        });
        logger.debug({ sessionId, type }, 'Added agent activity');
      });
    } catch (error) {
      logger.debug({ sessionId, error }, 'Failed to add agent activity');
    }
  }

  /**
   * Complete an agent session by posting a response activity
   */
  async completeAgentSession(sessionId: string, summary?: string): Promise<void> {
    try {
      await this.addAgentActivity(sessionId, 'response', {
        message: summary || 'Task completed successfully',
      });
      logger.info({ sessionId }, 'Completed agent session');
    } catch (error) {
      logger.debug({ sessionId, error }, 'Failed to complete agent session');
    }
  }

  /**
   * Mark an agent session as errored
   */
  async errorAgentSession(sessionId: string, errorMessage?: string): Promise<void> {
    try {
      await this.addAgentActivity(sessionId, 'error', {
        message: errorMessage || 'Task failed',
      });
      logger.info({ sessionId }, 'Marked agent session as errored');
    } catch (error) {
      logger.debug({ sessionId, error }, 'Failed to mark agent session as errored');
    }
  }

  private async mapIssueToTicket(issue: Issue): Promise<TicketInfo> {
    const state = await issue.state;
    const assignee = await issue.assignee;
    const labels = await issue.labels();

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      priority: issue.priority,
      state: state
        ? {
            id: state.id,
            name: state.name,
            type: state.type,
          }
        : { id: '', name: 'Unknown', type: 'unstarted' },
      assignee: assignee
        ? {
            id: assignee.id,
            name: assignee.name,
          }
        : null,
      labels: labels.nodes.map((l) => ({ id: l.id, name: l.name })),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
    };
  }
}

export const linearClient = new LinearApiClient();
