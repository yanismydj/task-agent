import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { linearClient } from '../linear/client.js';
import { readinessAnalyzer, type ScoredTicket } from '../analyzer/readiness.js';
import { agentPool } from '../agents/pool.js';
import type { TicketInfo, TicketComment } from '../linear/types.js';
import type { AgentResult } from '../agents/types.js';

const logger = createChildLogger({ module: 'scheduler' });

// Labels for tracking state
const TASK_AGENT_LABEL = 'task-agent';
const PENDING_APPROVAL_LABEL = 'ta:pending-approval';

// Comment markers
const APPROVAL_TAG = '[TaskAgent Proposal]';
const WORKING_TAG = '[TaskAgent Working]';

export class Scheduler {
  private processedTickets: Set<string> = new Set();

  constructor() {
    agentPool.setOnComplete(this.handleAgentComplete.bind(this));
  }

  async processTickets(tickets: TicketInfo[]): Promise<void> {
    logger.info({ count: tickets.length }, 'Processing tickets');

    // First, check for any tickets that have pending approvals with responses
    await this.checkAllPendingApprovals(tickets);

    // Track active agents
    const activeAgents = agentPool.getActiveAgents();
    for (const agent of activeAgents) {
      const ticketId = agent.ticketIdentifier;
      if (ticketId) {
        this.processedTickets.add(ticketId);
      }
    }

    const availableCount = agentPool.getAvailableCount();
    if (availableCount === 0) {
      logger.debug('No available agents');
      return;
    }

    // Check if we have any pending approvals (tickets with the label but no response yet)
    const pendingApprovalTickets = tickets.filter((t) =>
      t.labels.some((l) => l.name === PENDING_APPROVAL_LABEL)
    );

    if (pendingApprovalTickets.length > 0) {
      logger.debug(
        { pending: pendingApprovalTickets.length },
        'Waiting for approval responses'
      );
      return;
    }

    // Find candidate tickets (no assignment, no task-agent label, not processed)
    const candidateTickets = tickets.filter((t) => {
      if (this.processedTickets.has(t.identifier)) return false;
      if (t.labels.some((l) => l.name === TASK_AGENT_LABEL)) return false;
      if (t.labels.some((l) => l.name === PENDING_APPROVAL_LABEL)) return false;
      if (t.assignee) return false;
      return true;
    });

    if (candidateTickets.length === 0) {
      logger.debug('No candidate tickets');
      return;
    }

    // Score and rank tickets
    const scoredTickets = await readinessAnalyzer.rankTickets(candidateTickets.slice(0, 10));

    const topCandidate = scoredTickets.find((st) => st.readiness.ready);
    if (!topCandidate) {
      logger.info('No ready tickets found');
      return;
    }

    await this.requestApproval(topCandidate);
  }

  /**
   * Check all tickets with pending-approval label to see if they've been responded to
   */
  private async checkAllPendingApprovals(tickets: TicketInfo[]): Promise<void> {
    const pendingTickets = tickets.filter((t) =>
      t.labels.some((l) => l.name === PENDING_APPROVAL_LABEL)
    );

    for (const ticket of pendingTickets) {
      await this.checkTicketApproval(ticket);
    }
  }

  /**
   * Check a single ticket for approval response in comments
   */
  private async checkTicketApproval(ticket: TicketInfo): Promise<void> {
    const comments = await linearClient.getComments(ticket.id);

    // Find our proposal comment
    const proposalComment = comments.find(
      (c) => c.body.includes(APPROVAL_TAG) && c.user?.isMe
    );

    if (!proposalComment) {
      // We have the label but no proposal comment - clean up
      logger.warn(
        { ticketId: ticket.identifier },
        'Found pending-approval label but no proposal comment, cleaning up'
      );
      await linearClient.removeLabel(ticket.id, PENDING_APPROVAL_LABEL);
      return;
    }

    // Check for responses after the proposal
    const response = this.findApprovalResponse(comments, proposalComment.createdAt);

    if (response === 'approved') {
      logger.info({ ticketId: ticket.identifier }, 'Found approval response');
      await this.startWork(ticket);
    } else if (response === 'rejected') {
      logger.info({ ticketId: ticket.identifier }, 'Found rejection response');
      await linearClient.removeLabel(ticket.id, PENDING_APPROVAL_LABEL);
      this.processedTickets.add(ticket.identifier);
    }
    // If null, still waiting - do nothing
  }

  private async requestApproval(scored: ScoredTicket): Promise<void> {
    const { ticket, readiness } = scored;

    logger.info(
      { ticketId: ticket.identifier, score: readiness.score },
      'Requesting approval for ticket'
    );

    // Add the pending-approval label FIRST (persists across restarts)
    await linearClient.addLabel(ticket.id, PENDING_APPROVAL_LABEL);

    const commentBody = `${APPROVAL_TAG}

I'd like to start working on this ticket. Here's my analysis:

**Readiness Score**: ${readiness.score}/100
**Assessment**: ${readiness.reasoning}

${readiness.issues.length > 0 ? `**Potential Issues**:\n${readiness.issues.map((i) => `- ${i}`).join('\n')}` : ''}

${readiness.suggestions.length > 0 ? `**Suggestions**:\n${readiness.suggestions.map((s) => `- ${s}`).join('\n')}` : ''}

---
Reply with **"yes"** or **"approve"** to start, or **"no"** to skip this ticket.`;

    await linearClient.addComment(ticket.id, commentBody);

    logger.info({ ticketId: ticket.identifier }, 'Approval requested');
  }

  private findApprovalResponse(
    comments: TicketComment[],
    proposalTime: Date
  ): 'approved' | 'rejected' | null {
    // Sort comments newest first
    const sortedComments = comments.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    for (const comment of sortedComments) {
      // Skip our own comments
      if (comment.user?.isMe) continue;

      // Only look at comments after the proposal
      if (comment.createdAt <= proposalTime) continue;

      const body = comment.body.toLowerCase().trim();

      // Check for approval
      if (
        body === 'yes' ||
        body === 'approve' ||
        body === 'approved' ||
        body === 'go' ||
        body === 'start' ||
        body === 'ok' ||
        body === 'okay' ||
        body.includes('looks good') ||
        body.includes('go ahead') ||
        body.includes('sounds good') ||
        body.includes('please proceed') ||
        body.includes('proceed')
      ) {
        return 'approved';
      }

      // Check for rejection
      if (
        body === 'no' ||
        body === 'reject' ||
        body === 'skip' ||
        body === 'not now' ||
        body === 'wait' ||
        body === 'hold' ||
        body.includes("don't") ||
        body.includes('not yet') ||
        body.includes('hold off')
      ) {
        return 'rejected';
      }
    }

    return null;
  }

  private async startWork(ticket: TicketInfo): Promise<void> {
    // Remove pending-approval and add task-agent label
    await linearClient.removeLabel(ticket.id, PENDING_APPROVAL_LABEL);
    await linearClient.addLabel(ticket.id, TASK_AGENT_LABEL);

    await linearClient.addComment(ticket.id, `${WORKING_TAG}\n\nStarting work on this ticket...`);

    await agentPool.assignWork({
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      ticketTitle: ticket.title,
      ticketDescription: ticket.description || '',
      ticketUrl: ticket.url,
    });

    this.processedTickets.add(ticket.identifier);
  }

  private async handleAgentComplete(
    agentId: string,
    ticketIdentifier: string,
    result: AgentResult
  ): Promise<void> {
    logger.info(
      { agentId, ticketIdentifier, success: result.success },
      'Agent completed'
    );

    const tickets = await linearClient.getTickets();
    const ticket = tickets.find((t) => t.identifier === ticketIdentifier);

    if (!ticket) {
      logger.error({ ticketIdentifier }, 'Could not find ticket for completed agent');
      return;
    }

    if (result.success) {
      let comment = `Work completed successfully!`;
      if (result.prUrl) {
        comment += `\n\n**Pull Request**: ${result.prUrl}`;
      }
      await linearClient.addComment(ticket.id, comment);
    } else {
      const failedCount = this.getFailureCount(ticketIdentifier);

      if (failedCount >= config.agents.maxRetries) {
        await linearClient.addComment(
          ticket.id,
          `Failed to complete this ticket after ${failedCount} attempts.\n\n**Error**: ${result.error || 'Unknown error'}\n\nEscalating for human review.`
        );
        await linearClient.removeLabel(ticket.id, TASK_AGENT_LABEL);
      } else {
        await linearClient.addComment(
          ticket.id,
          `Attempt ${failedCount} failed: ${result.error || 'Unknown error'}\n\nRetrying...`
        );
      }
    }

    this.processedTickets.delete(ticketIdentifier);
  }

  private getFailureCount(_ticketIdentifier: string): number {
    // TODO: Track actual failure count
    return config.agents.maxRetries + 1;
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down scheduler');
    await agentPool.shutdown();
  }
}

export const scheduler = new Scheduler();
