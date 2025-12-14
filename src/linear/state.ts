import { LinearClient } from '@linear/sdk';
import os from 'node:os';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { initializeAuth, getAuth } from './auth.js';

const logger = createChildLogger({ module: 'linear-state' });

/**
 * TODO: State Management Consolidation
 *
 * This module currently implements a dual state tracking approach:
 *
 * 1. **State Project Issues** (this file):
 *    - Uses a "TaskAgent State" project in Linear
 *    - Creates issues for: Daemon status, Agent sessions, Error reports
 *    - Pros: Visible in Linear UI, persists across restarts
 *    - Cons: Creates many issues, API-intensive, separate from actual tickets
 *
 * 2. **Linear Agent Sessions** (src/linear/client.ts):
 *    - Uses Linear's native Agent Session API
 *    - Tracks agent work lifecycle with proper activity logging
 *    - Pros: Native Linear feature, better UI integration
 *    - Cons: Added after state project was implemented
 *
 * **Future Plan:**
 * - Consolidate agent session tracking to use ONLY Linear's native Agent Sessions
 * - Keep the State Project for daemon status and error reporting (no native alternative)
 * - Remove duplicate AgentSession tracking from this file
 * - This will reduce API calls and simplify the codebase
 *
 * **Migration Steps:**
 * 1. Verify Linear Agent Sessions API is stable (currently in Developer Preview)
 * 2. Remove createAgentSession/updateAgentSession/getActiveAgentSessions from this file
 * 3. Update processor.ts to only use linearClient agent session methods
 * 4. Clean up old "Agent Session:" issues in the State Project
 */

// State project for daemon metadata
const STATE_PROJECT_NAME = 'TaskAgent State';
const DAEMON_ISSUE_TITLE = 'Daemon Status';
const AGENT_ISSUE_PREFIX = 'Agent Session:';
const ERROR_ISSUE_PREFIX = 'Error:';

interface DaemonStatus {
  pid: number;
  startedAt: string;
  hostname: string;
  version: string;
  lastHeartbeat: string;
}

interface AgentSession {
  agentId: string;
  ticketId: string;
  ticketIdentifier: string;
  worktreePath: string;
  branchName: string;
  startedAt: string;
  status: 'working' | 'completed' | 'failed';
  processId?: number;
}

interface ErrorReport {
  module: string;
  error: string;
  stack?: string;
  context?: Record<string, unknown>;
  occurredAt: string;
}

export class LinearStateManager {
  private client: LinearClient | null = null;
  private teamId: string;
  private stateProjectId: string | null = null;
  private initialized = false;

  constructor() {
    this.teamId = config.linear.teamId;

    if (config.linear.auth.mode === 'apikey') {
      this.client = new LinearClient({ apiKey: config.linear.auth.apiKey });
    } else {
      // OAuth mode: initialize auth module if not already done
      try {
        getAuth();
      } catch {
        initializeAuth({
          clientId: config.linear.auth.clientId,
          clientSecret: config.linear.auth.clientSecret,
        });
      }
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

  // ============ State Project Management ============

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Linear state manager');

    const client = await this.getClient();
    const team = await client.team(this.teamId);
    const projects = await team.projects();
    const existingProject = projects.nodes.find((p) => p.name === STATE_PROJECT_NAME);

    if (existingProject) {
      this.stateProjectId = existingProject.id;
      logger.info({ projectId: this.stateProjectId }, 'Found existing state project');
    } else {
      const result = await client.createProject({
        teamIds: [this.teamId],
        name: STATE_PROJECT_NAME,
        description: 'Internal state tracking for TaskAgent. Do not modify manually.',
      });
      const project = await result.project;
      if (!project) {
        throw new Error('Failed to create state project');
      }
      this.stateProjectId = project.id;
      logger.info({ projectId: this.stateProjectId }, 'Created state project');
    }

    this.initialized = true;
  }

  // ============ Daemon Status ============

  async registerDaemon(): Promise<void> {
    await this.initialize();

    const status: DaemonStatus = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: '0.1.0',
      lastHeartbeat: new Date().toISOString(),
    };

    try {
      await this.upsertStateIssue(DAEMON_ISSUE_TITLE, status, 'started');
      logger.info({ pid: status.pid }, 'Registered daemon in Linear');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, 'Failed to register daemon');
      throw error;
    }
  }

  async updateHeartbeat(): Promise<void> {
    await this.initialize();

    const existing = await this.getStateIssue(DAEMON_ISSUE_TITLE);
    if (existing) {
      const status = JSON.parse(existing.description || '{}') as DaemonStatus;
      status.lastHeartbeat = new Date().toISOString();
      const client = await this.getClient();
      await client.updateIssue(existing.id, {
        description: JSON.stringify(status, null, 2),
      });
    }
  }

  async unregisterDaemon(): Promise<void> {
    await this.initialize();

    const existing = await this.getStateIssue(DAEMON_ISSUE_TITLE);
    if (existing) {
      const client = await this.getClient();
      const team = await client.team(this.teamId);
      const states = await team.states();
      const completedState = states.nodes.find((s) => s.type === 'completed');
      if (completedState) {
        await client.updateIssue(existing.id, { stateId: completedState.id });
      }
    }
    logger.info('Unregistered daemon from Linear');
  }

  async isDaemonRunning(): Promise<boolean> {
    await this.initialize();

    const existing = await this.getStateIssue(DAEMON_ISSUE_TITLE);
    if (!existing) return false;

    const state = await existing.state;
    return state?.type === 'started';
  }

  // ============ Agent Sessions ============

  async createAgentSession(session: Omit<AgentSession, 'startedAt' | 'status'>): Promise<void> {
    await this.initialize();

    const fullSession: AgentSession = {
      ...session,
      startedAt: new Date().toISOString(),
      status: 'working',
    };

    const title = `${AGENT_ISSUE_PREFIX} ${session.ticketIdentifier}`;
    await this.upsertStateIssue(title, fullSession, 'started');
    logger.info({ agentId: session.agentId, ticketId: session.ticketIdentifier }, 'Created agent session');
  }

  async updateAgentSession(ticketIdentifier: string, updates: Partial<AgentSession>): Promise<void> {
    await this.initialize();

    const title = `${AGENT_ISSUE_PREFIX} ${ticketIdentifier}`;
    const existing = await this.getStateIssue(title);

    if (existing) {
      const session = JSON.parse(existing.description || '{}') as AgentSession;
      Object.assign(session, updates);
      const client = await this.getClient();
      await client.updateIssue(existing.id, {
        description: JSON.stringify(session, null, 2),
      });

      if (updates.status === 'completed' || updates.status === 'failed') {
        const team = await client.team(this.teamId);
        const states = await team.states();
        const targetState = states.nodes.find((s) =>
          updates.status === 'completed' ? s.type === 'completed' : s.type === 'canceled'
        );
        if (targetState) {
          await client.updateIssue(existing.id, { stateId: targetState.id });
        }
      }
    }
  }

  async getActiveAgentSessions(): Promise<AgentSession[]> {
    await this.initialize();

    const client = await this.getClient();
    const allSessions: AgentSession[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    const PAGE_SIZE = 50;

    // Use pagination to handle many active sessions
    while (hasMore) {
      const issues = await client.issues({
        filter: {
          project: { id: { eq: this.stateProjectId! } },
          title: { startsWith: AGENT_ISSUE_PREFIX },
          state: { type: { eq: 'started' } },
        },
        first: PAGE_SIZE,
        after: cursor,
      });

      for (const issue of issues.nodes) {
        try {
          const session = JSON.parse(issue.description || '{}') as AgentSession;
          allSessions.push(session);
        } catch {
          // Skip invalid session data
        }
      }

      hasMore = issues.pageInfo.hasNextPage;
      cursor = issues.pageInfo.endCursor ?? undefined;
    }

    return allSessions;
  }

  // ============ Error Reporting ============

  async reportError(
    module: string,
    error: Error | string,
    context?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.initialize();

      const errorMessage = error instanceof Error ? error.message : error;
      const errorStack = error instanceof Error ? error.stack : undefined;

      const report: ErrorReport = {
        module,
        error: errorMessage,
        stack: errorStack,
        context,
        occurredAt: new Date().toISOString(),
      };

      // Create a unique title with timestamp to avoid collisions
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const title = `${ERROR_ISSUE_PREFIX} ${module} @ ${timestamp}`;

      const client = await this.getClient();
      const team = await client.team(this.teamId);
      const states = await team.states();
      const backlogState = states.nodes.find((s) => s.type === 'backlog') || states.nodes[0];

      await client.createIssue({
        teamId: this.teamId,
        projectId: this.stateProjectId!,
        title,
        description: this.formatErrorDescription(report),
        stateId: backlogState?.id,
      });

      logger.info({ module, error: errorMessage }, 'Reported error to Linear');
    } catch (reportingError) {
      // Don't let error reporting failures crash the daemon
      logger.error(
        {
          originalError: error instanceof Error ? error.message : error,
          reportingError: reportingError instanceof Error ? reportingError.message : String(reportingError),
        },
        'Failed to report error to Linear'
      );
    }
  }

  private formatErrorDescription(report: ErrorReport): string {
    let description = `## Error Details\n\n`;
    description += `**Module:** ${report.module}\n`;
    description += `**Time:** ${report.occurredAt}\n\n`;
    description += `### Message\n\`\`\`\n${report.error}\n\`\`\`\n\n`;

    if (report.stack) {
      description += `### Stack Trace\n\`\`\`\n${report.stack}\n\`\`\`\n\n`;
    }

    if (report.context && Object.keys(report.context).length > 0) {
      description += `### Context\n\`\`\`json\n${JSON.stringify(report.context, null, 2)}\n\`\`\`\n`;
    }

    return description;
  }

  // ============ Private Helpers ============

  private async getStateIssue(title: string) {
    const client = await this.getClient();
    const issues = await client.issues({
      filter: {
        project: { id: { eq: this.stateProjectId! } },
        title: { eq: title },
      },
    });
    return issues.nodes[0] || null;
  }

  private async upsertStateIssue(title: string, data: unknown, stateType: string): Promise<void> {
    logger.debug({ title, stateType, stateProjectId: this.stateProjectId }, 'Upserting state issue');
    const existing = await this.getStateIssue(title);
    const description = JSON.stringify(data, null, 2);
    const client = await this.getClient();

    if (existing) {
      logger.debug({ existingId: existing.id }, 'Found existing state issue, updating');
      await client.updateIssue(existing.id, { description });
      const team = await client.team(this.teamId);
      const states = await team.states();
      const targetState = states.nodes.find((s) => s.type === stateType);
      if (targetState) {
        await client.updateIssue(existing.id, { stateId: targetState.id });
      }
    } else {
      logger.debug('No existing state issue, creating new');
      const team = await client.team(this.teamId);
      const states = await team.states();
      const targetState = states.nodes.find((s) => s.type === stateType) || states.nodes[0];

      await client.createIssue({
        teamId: this.teamId,
        projectId: this.stateProjectId!,
        title,
        description,
        stateId: targetState?.id,
      });
    }
  }
}

export const stateManager = new LinearStateManager();
