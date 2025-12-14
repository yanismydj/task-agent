import {
  LinearClient,
  Issue,
  Comment,
  RateLimitPayload,
  AgentSession,
  LinearError,
  InvalidInputLinearError,
} from '@linear/sdk';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { initializeAuth, getAuth } from './auth.js';
import { linearCache } from './cache.js';
import { getDatabase } from '../queue/database.js';
import type { TicketInfo, TicketComment, TicketUpdate, ProjectLead, CommentInfo } from './types.js';

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

// Estimated complexity costs per operation type
// These are estimates based on typical query patterns
// Actual complexity depends on fields requested and pagination
const COMPLEXITY_ESTIMATES: Record<string, number> = {
  'getTicket': 10,
  'getTickets': 100, // Per page of 50
  'getComments': 50,
  'addComment': 5,
  'deleteComment': 5,
  'updateIssue': 10,
  'syncLabels': 50,
  'createAgentSession': 15,
  'addAgentActivity': 5,
  'checkRateLimit': 5,
  'getProjectLead': 20,
  'cacheWorkflowStates': 30,
};

export class LinearApiClient {
  private client: LinearClient | null = null;
  private teamId: string;
  private projectId?: string;
  private useOAuth: boolean;
  private rateLimitResetAt: Date | null = null;
  private lastRateLimitInfo: RateLimitInfo | null = null;
  private consecutiveErrors = 0;

  // Complexity tracking for debugging
  private estimatedComplexityUsed = 0;
  private complexityTrackingStartTime = Date.now();

  // Cache the bot's user ID for identifying our own comments
  private botUserId: string | null = null;

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
   * Get the bot's user ID (fetches and caches on first call)
   */
  async getBotUserId(): Promise<string> {
    if (this.botUserId) {
      return this.botUserId;
    }

    const client = await this.getClient();
    const me = await client.viewer;
    this.botUserId = me.id;
    logger.info({ botUserId: this.botUserId }, 'Cached bot user ID');
    return this.botUserId;
  }

  /**
   * Get the bot's user ID if already cached (synchronous)
   * Returns null if not yet fetched
   */
  getCachedBotUserId(): string | null {
    return this.botUserId;
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
   * Log estimated complexity for an operation
   * Helps track API usage and identify optimization opportunities
   */
  private logComplexity(operation: string, multiplier = 1): void {
    const estimate = (COMPLEXITY_ESTIMATES[operation] ?? 20) * multiplier;
    this.estimatedComplexityUsed += estimate;

    // Reset tracking every hour (matching Linear's rate limit window)
    const hoursSinceStart = (Date.now() - this.complexityTrackingStartTime) / (60 * 60 * 1000);
    if (hoursSinceStart >= 1) {
      logger.debug(
        { estimatedComplexity: this.estimatedComplexityUsed, hourlyLimit: COMPLEXITY_PER_HOUR },
        'Resetting complexity tracking (new hour)'
      );
      this.estimatedComplexityUsed = estimate;
      this.complexityTrackingStartTime = Date.now();
    }

    logger.debug(
      {
        operation,
        estimatedCost: estimate,
        totalEstimated: this.estimatedComplexityUsed,
        hourlyLimit: COMPLEXITY_PER_HOUR,
        percentUsed: ((this.estimatedComplexityUsed / COMPLEXITY_PER_HOUR) * 100).toFixed(1) + '%',
      },
      'API complexity estimate'
    );
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
   * Uses LinearError types when available for more reliable detection
   */
  private isTransientError(error: unknown): boolean {
    // Check for Linear SDK specific error types first
    if (error instanceof LinearError) {
      // Log structured error info for debugging
      logger.debug(
        {
          errorType: error.name,
          message: error.message,
          // LinearError may have additional properties
          ...(error.errors ? { errors: error.errors } : {}),
        },
        'LinearError detected'
      );

      // Server errors (5xx) are transient
      // Note: LinearError types may include status information
      const message = error.message.toLowerCase();
      if (message.includes('503') || message.includes('502') || message.includes('504')) {
        return true;
      }

      // Check for network errors in the underlying cause (fetch failed, ECONNRESET, etc.)
      // LinearError wraps the raw error in a 'raw' property
      const rawError = (error as unknown as { raw?: Error }).raw;
      if (rawError) {
        const rawMessage = rawError.message?.toLowerCase() || '';
        const causeMessage = (rawError.cause as Error)?.message?.toLowerCase() || '';
        if (
          rawMessage.includes('fetch failed') ||
          rawMessage.includes('network') ||
          causeMessage.includes('econnreset') ||
          causeMessage.includes('econnrefused') ||
          causeMessage.includes('etimedout')
        ) {
          logger.debug({ rawMessage, causeMessage }, 'Network error detected in LinearError');
          return true;
        }
      }

      // Some LinearErrors are not transient (e.g., validation errors)
      return false;
    }

    // InvalidInputLinearError is never transient - it's a client-side error
    if (error instanceof InvalidInputLinearError) {
      logger.warn(
        { error: error.message },
        'Invalid input error - will not retry'
      );
      return false;
    }

    // Fallback to string matching for non-Linear errors (network issues, etc.)
    if (error instanceof Error) {
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

    return false;
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

    // Use pagination to handle teams with many issues
    // Linear defaults to 50 items, we fetch in batches until all are retrieved
    const allTickets: TicketInfo[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    const PAGE_SIZE = 50;
    let pageCount = 0;

    while (hasMore) {
      const result = await this.withRetry(async (client) => {
        const issues = await client.issues({
          filter,
          first: PAGE_SIZE,
          after: cursor,
        });

        // Use fast mapper - no extra API calls per issue!
        // Requires workflow states and labels to be cached at startup
        const tickets: TicketInfo[] = issues.nodes.map((issue) =>
          this.mapIssueToTicketFast(issue)
        );

        return {
          tickets,
          hasNextPage: issues.pageInfo.hasNextPage,
          endCursor: issues.pageInfo.endCursor,
        };
      });

      pageCount++;
      this.logComplexity('getTickets', 1); // Log complexity per page

      allTickets.push(...result.tickets);
      hasMore = result.hasNextPage;
      cursor = result.endCursor ?? undefined;

      if (hasMore) {
        logger.debug({ fetched: allTickets.length, cursor }, 'Fetching next page of tickets');
      }
    }

    // Cache all fetched tickets
    linearCache.upsertTickets(allTickets);

    logger.info({ count: allTickets.length }, 'Fetched tickets from Linear');
    return allTickets;
  }

  /**
   * Get tickets from cache only (no API call)
   * Use this when you want to avoid API calls and can tolerate stale data
   */
  getCachedTickets(options?: { stateType?: string; hasLabel?: string }): TicketInfo[] {
    return linearCache.getTickets(options);
  }

  async getTicket(issueId: string): Promise<TicketInfo | null> {
    try {
      return this.withRetry(async (client) => {
        const issue = await client.issue(issueId);
        const ticket = await this.mapIssueToTicket(issue);
        // Cache the fetched ticket
        linearCache.upsertTicket(ticket);
        return ticket;
      });
    } catch (error) {
      logger.error({ issueId, error }, 'Failed to fetch ticket');
      return null;
    }
  }

  /**
   * Get a ticket, preferring cache if available and fresh enough
   * @param maxAgeSeconds - Maximum cache age in seconds (default: 300 = 5 minutes)
   */
  async getTicketCached(issueId: string, maxAgeSeconds = 300): Promise<TicketInfo | null> {
    // Check cache first
    const cached = linearCache.getTicket(issueId);
    if (cached) {
      const cacheAge = linearCache.getTicketCacheAge(issueId);
      if (cacheAge !== null && cacheAge < maxAgeSeconds) {
        logger.debug({ issueId, cacheAge }, 'Using cached ticket');
        return cached;
      }
    }

    // Cache miss or stale - fetch from API
    return this.getTicket(issueId);
  }

  /**
   * Get a ticket from cache only (no API call)
   */
  getCachedTicket(issueId: string): TicketInfo | null {
    return linearCache.getTicket(issueId);
  }

  async getComments(issueId: string): Promise<TicketComment[]> {
    return this.withRetry(async (client) => {
      const issue = await client.issue(issueId);
      const comments = await issue.comments();
      const me = await client.viewer;

      const result = await Promise.all(
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

      // Cache all comments for this ticket
      const commentsForCache: CommentInfo[] = result.map(c => ({
        id: c.id,
        body: c.body,
        user: c.user ? { id: c.user.id, name: c.user.name, isBot: c.user.isMe } : undefined,
        createdAt: c.createdAt,
        updatedAt: c.createdAt, // Linear comments don't have separate updatedAt
      }));
      linearCache.upsertComments(issueId, commentsForCache);

      return result;
    });
  }

  /**
   * Get comments, preferring cache if available
   * Will fetch from API if cache is empty for this ticket
   */
  async getCommentsCached(issueId: string): Promise<TicketComment[]> {
    // Check if we have cached comments
    if (linearCache.hasComments(issueId)) {
      const cached = linearCache.getComments(issueId);
      logger.debug({ issueId, count: cached.length }, 'Using cached comments');
      // Convert CommentInfo to TicketComment format
      return cached.map(c => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        user: c.user ? { id: c.user.id, name: c.user.name, isMe: c.user.isBot || false } : null,
      }));
    }

    // Cache miss - fetch from API
    return this.getComments(issueId);
  }

  /**
   * Get comments from cache only (no API call)
   */
  getCachedComments(issueId: string): CommentInfo[] {
    return linearCache.getComments(issueId);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    logger.debug({ issueId }, 'Adding comment to ticket');
    this.logComplexity('addComment');

    const result = await this.withRetry(async (client) => {
      const commentPayload = await client.createComment({ issueId, body });
      const comment = await commentPayload.comment;
      return comment;
    });

    // Cache the comment locally to prevent duplicate detection issues
    if (result) {
      linearCache.upsertComment(issueId, {
        id: result.id,
        body: body,
        user: {
          id: 'taskagent',
          name: 'TaskAgent',
          isBot: true,
        },
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      });
    }

    logger.info({ issueId }, 'Added comment to ticket');
  }

  async deleteComment(commentId: string): Promise<void> {
    logger.debug({ commentId }, 'Deleting comment');
    this.logComplexity('deleteComment');

    await this.withRetry(async (client) => {
      await client.deleteComment(commentId);
    });

    // Remove from local cache
    linearCache.deleteComment(commentId);

    logger.info({ commentId }, 'Deleted comment');
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

  /**
   * Update the ticket title
   */
  async updateTitle(issueId: string, title: string): Promise<void> {
    logger.debug({ issueId, titleLength: title.length }, 'Updating ticket title');
    await this.withRetry(async (client) => {
      await client.updateIssue(issueId, { title });
    });
    logger.info({ issueId }, 'Updated ticket title');
  }

  /**
   * Resolve a comment thread (mark as resolved)
   */
  async resolveComment(commentId: string): Promise<void> {
    logger.debug({ commentId }, 'Resolving comment');
    await this.withRetry(async (client) => {
      await client.commentResolve(commentId);
    });
    logger.debug({ commentId }, 'Resolved comment');
  }

  /**
   * Resolve multiple comments
   */
  async resolveComments(commentIds: string[]): Promise<void> {
    if (commentIds.length === 0) return;

    logger.info({ count: commentIds.length }, 'Resolving comments');
    for (const commentId of commentIds) {
      try {
        await this.resolveComment(commentId);
      } catch (error) {
        logger.warn({ commentId, error }, 'Failed to resolve comment (non-fatal)');
      }
    }
    logger.info({ count: commentIds.length }, 'Resolved comments');
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
   * Get workflow states for the team (cached)
   * Fetches from cache if available, otherwise from API
   */
  async getWorkflowStates(): Promise<Array<{ id: string; name: string; type: string }>> {
    // Check cache first
    if (linearCache.hasWorkflowStates(this.teamId)) {
      const cached = linearCache.getWorkflowStates(this.teamId);
      logger.debug({ teamId: this.teamId, count: cached.length }, 'Using cached workflow states');
      return cached;
    }

    // Cache miss - fetch from API and cache
    return this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const states = await team.states();
      const result = states.nodes.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      }));

      // Cache the workflow states
      linearCache.cacheWorkflowStates(this.teamId, result);

      return result;
    });
  }

  /**
   * Pre-cache workflow states at startup
   * Call this once during initialization to avoid API calls later
   */
  async cacheWorkflowStatesAtStartup(): Promise<void> {
    try {
      await this.getWorkflowStates();
      logger.info({ teamId: this.teamId }, 'Workflow states cached at startup');
    } catch (error) {
      logger.warn({ error }, 'Failed to cache workflow states at startup');
    }
  }

  /**
   * Get team labels (cached)
   * Fetches from cache if available, otherwise from API
   */
  async getLabels(): Promise<Array<{ id: string; name: string }>> {
    // Check cache first
    if (linearCache.hasLabels(this.teamId)) {
      const db = getDatabase();
      const stmt = db.prepare('SELECT id, name FROM linear_labels_cache WHERE team_id = ?');
      const rows = stmt.all(this.teamId) as Array<{ id: string; name: string }>;
      logger.debug({ teamId: this.teamId, count: rows.length }, 'Using cached labels');
      return rows;
    }

    // Cache miss - fetch from API and cache
    return this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const labels = await team.labels();
      const result = labels.nodes.map((l) => ({
        id: l.id,
        name: l.name,
      }));

      // Cache the labels
      linearCache.cacheLabels(this.teamId, result);

      return result;
    });
  }

  /**
   * Pre-cache labels at startup
   * Call this once during initialization to avoid API calls later
   */
  async cacheLabelsAtStartup(): Promise<void> {
    try {
      await this.getLabels();
      logger.info({ teamId: this.teamId }, 'Labels cached at startup');
    } catch (error) {
      logger.warn({ error }, 'Failed to cache labels at startup');
    }
  }

  /**
   * Set issue state to "Up Next" (or equivalent unstarted/triaged state)
   * Used to transition tickets from backlog to ready-for-work state
   */
  async setIssueUpNext(issueId: string): Promise<void> {
    await this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const states = await team.states();

      // Find "Up Next" or "Todo" state - type 'unstarted' but not 'backlog'
      // Linear has two unstarted types: backlog and regular unstarted (e.g., "Todo", "Up Next")
      const upNextState = states.nodes.find(
        (s) =>
          s.type === 'unstarted' &&
          (s.name.toLowerCase() === 'up next' ||
            s.name.toLowerCase() === 'todo' ||
            s.name.toLowerCase() === 'to do' ||
            s.name.toLowerCase() === 'ready')
      );

      if (upNextState) {
        await client.updateIssue(issueId, { stateId: upNextState.id });
        logger.info({ issueId, stateName: upNextState.name }, 'Set issue to Up Next');
      } else {
        // Fallback: find any unstarted state that isn't backlog
        const anyUnstarted = states.nodes.find(
          (s) => s.type === 'unstarted' && s.name.toLowerCase() !== 'backlog'
        );
        if (anyUnstarted) {
          await client.updateIssue(issueId, { stateId: anyUnstarted.id });
          logger.info({ issueId, stateName: anyUnstarted.name }, 'Set issue to unstarted state');
        } else {
          logger.warn({ issueId }, 'No "Up Next" or unstarted state found for team');
        }
      }
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
   * Set issue state to "In Review" (or equivalent review state)
   */
  async setIssueInReview(issueId: string): Promise<void> {
    await this.withRetry(async (client) => {
      const team = await client.team(this.teamId);
      const states = await team.states();

      // Find "In Review" state (case-insensitive match)
      const reviewState = states.nodes.find(
        (s) => s.name.toLowerCase() === 'in review'
      );

      if (reviewState) {
        await client.updateIssue(issueId, { stateId: reviewState.id });
        logger.info({ issueId, stateName: reviewState.name }, 'Set issue to In Review');
      } else {
        logger.warn({ issueId }, 'No "In Review" state found for team');
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

  /**
   * Map an Issue to TicketInfo using cached data for state and labels.
   * This avoids extra API calls by using:
   * - issue.stateId + cached workflow states
   * - issue.labelIds + cached label names
   * - issue.assigneeId (we only need to know if assigned, not the name)
   */
  private mapIssueToTicketFast(issue: Issue): TicketInfo {
    // Get state from cache using stateId (no API call!)
    const stateId = (issue as unknown as { stateId?: string }).stateId;
    let state: { id: string; name: string; type: string } = { id: '', name: 'Unknown', type: 'unstarted' };
    if (stateId) {
      const cachedState = linearCache.getWorkflowState(stateId);
      if (cachedState) {
        state = cachedState;
      } else {
        // Fallback - state not in cache, use ID only
        state = { id: stateId, name: 'Unknown', type: 'unstarted' };
      }
    }

    // Get assignee info - we only need ID to know if assigned
    const assigneeId = (issue as unknown as { assigneeId?: string }).assigneeId;

    // Get labels from cache using labelIds (no API call!)
    const labelIds = issue.labelIds || [];
    const labelNameMap = linearCache.getLabelNames(labelIds);
    const labels = labelIds.map((id) => ({
      id,
      name: labelNameMap.get(id) || 'Unknown',
    }));

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      priority: issue.priority,
      state,
      assignee: assigneeId
        ? {
            id: assigneeId,
            name: '', // We don't need the name, just that it's assigned
          }
        : null,
      labels,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
    };
  }

  /**
   * Map an Issue to TicketInfo with full API fetches (slow, but complete data)
   * Use mapIssueToTicketFast for batch operations
   * @deprecated Use mapIssueToTicketFast for better performance
   */
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
