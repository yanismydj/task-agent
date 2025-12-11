import { LinearClient, Issue, Comment } from '@linear/sdk';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { initializeAuth, getAuth } from './auth.js';
import type { TicketInfo, TicketComment, TicketUpdate } from './types.js';

const logger = createChildLogger({ module: 'linear-client' });

export class LinearApiClient {
  private client: LinearClient | null = null;
  private teamId: string;
  private projectId?: string;
  private useOAuth: boolean;

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

  // Wrap API calls to handle 401 errors and refresh token
  private async withRetry<T>(operation: (client: LinearClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      return await operation(client);
    } catch (error) {
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
