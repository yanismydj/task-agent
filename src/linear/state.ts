import { LinearClient } from '@linear/sdk';
import os from 'node:os';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { initializeAuth, getAuth } from './auth.js';
import type { TicketInfo } from './types.js';

const logger = createChildLogger({ module: 'linear-state' });

// Label prefixes for TaskAgent state on tickets
const LABEL_PREFIX = 'ta:';
const READINESS_LABEL_PREFIX = 'readiness:';

// State project for daemon metadata
const STATE_PROJECT_NAME = 'TaskAgent State';
const DAEMON_ISSUE_TITLE = 'Daemon Status';
const AGENT_ISSUE_PREFIX = 'Agent Session:';
const ERROR_ISSUE_PREFIX = 'Error:';

export type TicketState = 'evaluated' | 'pending-approval' | 'working' | 'completed' | 'failed';

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
  private labelCache: Map<string, string> = new Map();
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

    await this.upsertStateIssue(DAEMON_ISSUE_TITLE, status, 'started');
    logger.info({ pid: status.pid }, 'Registered daemon in Linear');
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
    const issues = await client.issues({
      filter: {
        project: { id: { eq: this.stateProjectId! } },
        title: { startsWith: AGENT_ISSUE_PREFIX },
        state: { type: { eq: 'started' } },
      },
    });

    return issues.nodes.map((issue) => {
      try {
        return JSON.parse(issue.description || '{}') as AgentSession;
      } catch {
        return null;
      }
    }).filter((s): s is AgentSession => s !== null);
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

  // ============ Ticket Labels (Readiness & State) ============

  async getTicketState(ticket: TicketInfo): Promise<TicketState | null> {
    const stateLabel = ticket.labels.find((l) =>
      l.name.startsWith(LABEL_PREFIX) && !l.name.startsWith('ta:eval:')
    );
    if (!stateLabel) return null;
    return stateLabel.name.replace(LABEL_PREFIX, '') as TicketState;
  }

  async getReadinessScore(ticket: TicketInfo): Promise<number | null> {
    const readinessLabel = ticket.labels.find((l) => l.name.startsWith(READINESS_LABEL_PREFIX));
    if (!readinessLabel) return null;
    const score = parseInt(readinessLabel.name.replace(READINESS_LABEL_PREFIX, ''), 10);
    return isNaN(score) ? null : score;
  }

  async setTicketState(ticketId: string, state: TicketState): Promise<void> {
    await this.removeLabelsWithPrefix(ticketId, LABEL_PREFIX, ['ta:eval:']);
    await this.addLabel(ticketId, `${LABEL_PREFIX}${state}`);
    logger.info({ ticketId, state }, 'Set ticket state');
  }

  async setReadinessScore(ticketId: string, score: number): Promise<void> {
    await this.removeLabelsWithPrefix(ticketId, READINESS_LABEL_PREFIX);
    await this.addLabel(ticketId, `${READINESS_LABEL_PREFIX}${score}`);
    logger.debug({ ticketId, score }, 'Set readiness score');
  }

  async needsEvaluation(ticket: TicketInfo): Promise<boolean> {
    const hasReadiness = ticket.labels.some((l) => l.name.startsWith(READINESS_LABEL_PREFIX));
    if (!hasReadiness) return true;

    const evalLabel = ticket.labels.find((l) => l.name.startsWith('ta:eval:'));
    if (!evalLabel) return true;

    const evalTime = new Date(evalLabel.name.replace('ta:eval:', ''));
    return ticket.updatedAt > evalTime;
  }

  async markEvaluated(ticketId: string): Promise<void> {
    await this.removeLabelsWithPrefix(ticketId, 'ta:eval:');
    await this.addLabel(ticketId, `ta:eval:${new Date().toISOString()}`);
  }

  async clearTicketState(ticketId: string): Promise<void> {
    await this.removeLabelsWithPrefix(ticketId, LABEL_PREFIX);
    await this.removeLabelsWithPrefix(ticketId, READINESS_LABEL_PREFIX);
    logger.info({ ticketId }, 'Cleared ticket state');
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
    const existing = await this.getStateIssue(title);
    const description = JSON.stringify(data, null, 2);
    const client = await this.getClient();

    if (existing) {
      await client.updateIssue(existing.id, { description });
      const team = await client.team(this.teamId);
      const states = await team.states();
      const targetState = states.nodes.find((s) => s.type === stateType);
      if (targetState) {
        await client.updateIssue(existing.id, { stateId: targetState.id });
      }
    } else {
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

  private async addLabel(ticketId: string, labelName: string): Promise<void> {
    const labelId = await this.getOrCreateLabel(labelName);
    const client = await this.getClient();
    const issue = await client.issue(ticketId);
    const existingLabels = await issue.labels();
    const existingIds = existingLabels.nodes.map((l) => l.id);

    if (!existingIds.includes(labelId)) {
      await client.updateIssue(ticketId, {
        labelIds: [...existingIds, labelId],
      });
    }
  }

  private async removeLabelsWithPrefix(ticketId: string, prefix: string, excludePrefixes: string[] = []): Promise<void> {
    const client = await this.getClient();
    const issue = await client.issue(ticketId);
    const existingLabels = await issue.labels();
    const filteredIds = existingLabels.nodes
      .filter((l) => {
        if (!l.name.startsWith(prefix)) return true;
        return excludePrefixes.some((exc) => l.name.startsWith(exc));
      })
      .map((l) => l.id);

    if (filteredIds.length !== existingLabels.nodes.length) {
      await client.updateIssue(ticketId, { labelIds: filteredIds });
    }
  }

  private async getOrCreateLabel(labelName: string): Promise<string> {
    const cached = this.labelCache.get(labelName);
    if (cached) return cached;

    const client = await this.getClient();
    const team = await client.team(this.teamId);
    const labels = await team.labels();
    const existing = labels.nodes.find((l) => l.name === labelName);

    if (existing) {
      this.labelCache.set(labelName, existing.id);
      return existing.id;
    }

    const result = await client.createIssueLabel({
      teamId: this.teamId,
      name: labelName,
      color: this.getLabelColor(labelName),
    });

    const newLabel = await result.issueLabel;
    if (!newLabel) throw new Error(`Failed to create label: ${labelName}`);

    this.labelCache.set(labelName, newLabel.id);
    return newLabel.id;
  }

  private getLabelColor(labelName: string): string {
    if (labelName.startsWith('readiness:')) {
      const score = parseInt(labelName.replace('readiness:', ''), 10);
      if (score >= 80) return '#22c55e';
      if (score >= 50) return '#eab308';
      return '#ef4444';
    }
    if (labelName.includes('working')) return '#3b82f6';
    if (labelName.includes('pending')) return '#f59e0b';
    if (labelName.includes('completed')) return '#22c55e';
    if (labelName.includes('failed')) return '#ef4444';
    return '#6b7280';
  }
}

export const stateManager = new LinearStateManager();
