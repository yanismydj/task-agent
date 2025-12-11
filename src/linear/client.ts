import { LinearClient, Issue, Comment } from '@linear/sdk';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { initializeAuth, getAuth } from './auth.js';
import type { TicketInfo, TicketComment, TicketUpdate, ProjectLead } from './types.js';

const logger = createChildLogger({ module: 'linear-client' });

export class RateLimitError extends Error {
  constructor(
    public readonly resetAt: Date,
    message?: string
  ) {
    super(message || `Rate limited until ${resetAt.toLocaleTimeString()}`);
    this.name = 'RateLimitError';
  }
}

export class LinearApiClient {
  private client: LinearClient | null = null;
  private teamId: string;
  private projectId?: string;
  private useOAuth: boolean;
  private rateLimitResetAt: Date | null = null;

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
   * Check if an error is a rate limit error and extract reset time
   */
  private extractRateLimitInfo(error: unknown): Date | null {
    if (!(error instanceof Error)) return null;

    const errorStr = String(error);

    // Check for rate limit error
    if (!errorStr.includes('Rate limit exceeded') && !errorStr.includes('RATELIMITED')) {
      return null;
    }

    // Linear rate limit is 1 hour (3600000ms)
    // Set reset time to 1 hour from now
    return new Date(Date.now() + 3600000);
  }

  // Wrap API calls to handle 401 errors and refresh token
  private async withRetry<T>(operation: (client: LinearClient) => Promise<T>): Promise<T> {
    // Check if we're rate limited before making the call
    if (this.isRateLimited()) {
      throw new RateLimitError(this.rateLimitResetAt!);
    }

    const client = await this.getClient();
    try {
      return await operation(client);
    } catch (error) {
      // Check if it's a rate limit error
      const resetAt = this.extractRateLimitInfo(error);
      if (resetAt) {
        this.rateLimitResetAt = resetAt;
        logger.warn(
          { resetAt: resetAt.toLocaleTimeString() },
          'Linear rate limit hit'
        );
        throw new RateLimitError(resetAt);
      }

      // Check if it's a 401 error and we're using OAuth
      if (this.useOAuth && error instanceof Error && error.message.includes('401')) {
        logger.info('Got 401, refreshing OAuth token');
        const auth = getAuth();
        auth.invalidateToken();
        this.client = null; // Force client recreation
        const newClient = await this.getClient();
        return await operation(newClient);
      }
      throw error;
    }
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
