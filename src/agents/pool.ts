import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { setAgentStateGetter } from '../utils/terminal.js';
import { AgentWorker } from './worker.js';
import { worktreeManager } from './worktree.js';
import type { AgentResult, AgentState, WorkAssignment } from './types.js';

const logger = createChildLogger({ module: 'agent-pool' });

export type AgentCompleteHandler = (
  agentId: string,
  ticketIdentifier: string,
  result: AgentResult
) => Promise<void>;

export class AgentPool {
  private agents: Map<string, AgentWorker> = new Map();
  private onComplete: AgentCompleteHandler | null = null;

  constructor() {
    for (let i = 0; i < config.agents.maxConcurrent; i++) {
      const agentId = `agent-${i + 1}`;
      this.agents.set(agentId, new AgentWorker(agentId));
    }
    logger.info({ count: config.agents.maxConcurrent }, 'Agent pool initialized');
  }

  setOnComplete(handler: AgentCompleteHandler): void {
    this.onComplete = handler;
  }

  getAvailableAgent(): AgentWorker | null {
    for (const agent of this.agents.values()) {
      if (agent.isIdle()) {
        return agent;
      }
    }
    return null;
  }

  getAvailableCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.isIdle()) {
        count++;
      }
    }
    return count;
  }

  getActiveAgents(): AgentWorker[] {
    return Array.from(this.agents.values()).filter((a) => !a.isIdle());
  }

  getAgentByTicket(ticketIdentifier: string): AgentWorker | null {
    for (const agent of this.agents.values()) {
      if (agent.ticketIdentifier === ticketIdentifier) {
        return agent;
      }
    }
    return null;
  }

  getAllStates(): AgentState[] {
    return Array.from(this.agents.values()).map((a) => a.getState());
  }

  getTerminalState(): { agents: Array<{ id: string; ticketIdentifier: string; status: string; startedAt: Date }>; available: number; total: number } {
    const activeAgents = this.getActiveAgents().map((a) => {
      const state = a.getState();
      return {
        id: a.id,
        ticketIdentifier: state.ticketIdentifier || 'Unknown',
        status: state.status,
        startedAt: state.startedAt || new Date(),
      };
    });

    return {
      agents: activeAgents,
      available: this.getAvailableCount(),
      total: config.agents.maxConcurrent,
    };
  }

  async assignWork(assignment: WorkAssignment): Promise<AgentWorker | null> {
    const agent = this.getAvailableAgent();
    if (!agent) {
      logger.warn('No available agents for assignment');
      return null;
    }

    try {
      const { path, branch } = await worktreeManager.create(assignment.ticketIdentifier);
      agent.assign(assignment, path, branch);

      await agent.start(async (result) => {
        await this.handleAgentComplete(agent, result);
      });

      return agent;
    } catch (error) {
      logger.error({ error, ticketId: assignment.ticketIdentifier }, 'Failed to assign work');
      return null;
    }
  }

  async retryAgent(agent: AgentWorker): Promise<boolean> {
    if (agent.retryCount >= config.agents.maxRetries) {
      logger.warn(
        { agentId: agent.id, retryCount: agent.retryCount },
        'Max retries exceeded'
      );
      return false;
    }

    const state = agent.getState();
    if (!state.ticketId || !state.ticketIdentifier) {
      logger.error({ agentId: agent.id }, 'Cannot retry - missing ticket info');
      return false;
    }

    agent.incrementRetry();
    logger.info(
      { agentId: agent.id, retryCount: agent.retryCount },
      'Retrying agent'
    );

    try {
      const { path, branch } = await worktreeManager.create(state.ticketIdentifier);
      agent.assign(
        {
          ticketId: state.ticketId,
          ticketIdentifier: state.ticketIdentifier,
          ticketTitle: '',
          ticketDescription: '',
          ticketUrl: '',
        },
        path,
        branch
      );

      await agent.start(async (result) => {
        await this.handleAgentComplete(agent, result);
      });

      return true;
    } catch (error) {
      logger.error({ error, agentId: agent.id }, 'Failed to retry agent');
      return false;
    }
  }

  async releaseAgent(agent: AgentWorker): Promise<void> {
    const state = agent.getState();

    if (state.ticketIdentifier) {
      try {
        await worktreeManager.remove(state.ticketIdentifier);
      } catch (error) {
        logger.warn(
          { error, ticketId: state.ticketIdentifier },
          'Failed to remove worktree'
        );
      }
    }

    agent.reset();
    logger.info({ agentId: agent.id }, 'Agent released');
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down agent pool');

    for (const agent of this.agents.values()) {
      if (!agent.isIdle()) {
        agent.kill();
      }
    }

    for (const agent of this.agents.values()) {
      await this.releaseAgent(agent);
    }
  }

  private async handleAgentComplete(agent: AgentWorker, result: AgentResult): Promise<void> {
    const ticketIdentifier = agent.ticketIdentifier;

    if (!ticketIdentifier) {
      logger.error({ agentId: agent.id }, 'Agent completed without ticket identifier');
      await this.releaseAgent(agent);
      return;
    }

    if (this.onComplete) {
      await this.onComplete(agent.id, ticketIdentifier, result);
    }

    if (!result.success && agent.retryCount < config.agents.maxRetries) {
      const retried = await this.retryAgent(agent);
      if (retried) {
        return;
      }
    }

    await this.releaseAgent(agent);
  }
}

export const agentPool = new AgentPool();

// Register the terminal state getter
setAgentStateGetter(() => agentPool.getTerminalState());
