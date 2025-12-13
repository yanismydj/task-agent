import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { linearClient } from '../linear/client.js';
import type { TicketInfo, TicketComment, ProjectLead } from '../linear/types.js';
import { worktreeManager } from '../agents/worktree.js';
import {
  readinessScorerAgent,
  ticketRefinerAgent,
  promptGeneratorAgent,
  codeExecutorAgent,
} from '../agents/impl/index.js';
import type {
  AgentInput,
  ReadinessScorerInput,
  ReadinessScorerOutput,
  TicketRefinerInput,
  PromptGeneratorInput,
} from '../agents/core/index.js';
import {
  ticketStateMachine,
  type TicketState,
} from './state-machine.js';
import {
  type TicketWorkflowState,
  LINEAR_LABELS,
  isTerminalState,
  requiresHumanInput,
} from './states.js';

const logger = createChildLogger({ module: 'workflow-engine' });

const READINESS_THRESHOLD = 70;

// Helper to check if a ticket's Linear state is 'backlog'
function isBacklogState(ticket: TicketInfo): boolean {
  const stateType = ticket.state.type?.toLowerCase();
  const stateName = ticket.state.name?.toLowerCase();
  return stateType === 'backlog' || stateName === 'backlog';
}

// Helper to check if a comment is from TaskAgent
function isTaskAgentComment(user?: { id?: string; isMe?: boolean } | null): boolean {
  // Primary: check user.isMe flag from API (most reliable)
  if (user?.isMe) return true;
  // Fallback: check user ID against cached bot ID
  if (user?.id) {
    const botUserId = linearClient.getCachedBotUserId();
    if (botUserId && user.id === botUserId) return true;
  }
  return false;
}

// Track active agent sessions per ticket
const agentSessions = new Map<string, string>(); // ticketId -> sessionId

interface ProcessingResult {
  ticketId: string;
  ticketIdentifier: string;
  previousState: TicketWorkflowState;
  newState: TicketWorkflowState;
  action: string;
}

export class WorkflowEngine {
  private processing: Set<string> = new Set();
  private projectLead: ProjectLead | null = null;
  private projectLeadFetched = false;

  /**
   * Get the project lead (fetches once and caches)
   */
  private async getProjectLead(): Promise<ProjectLead | null> {
    if (!this.projectLeadFetched) {
      try {
        this.projectLead = await linearClient.getProjectLead();
        if (this.projectLead) {
          logger.info(
            { leadName: this.projectLead.displayName },
            'Project lead loaded for mentions'
          );
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to fetch project lead');
      }
      this.projectLeadFetched = true;
    }
    return this.projectLead;
  }

  /**
   * Format a mention string for the project lead (if available)
   */
  private async formatLeadMention(): Promise<string> {
    const lead = await this.getProjectLead();
    if (lead) {
      return `${linearClient.formatUserMention(lead)} `;
    }
    return '';
  }

  /**
   * Transition ticket from backlog to Up Next if currently in backlog state.
   * This surfaces ready tickets to the user before requesting approval.
   */
  private async transitionFromBacklogIfNeeded(ticket: TicketInfo): Promise<void> {
    if (isBacklogState(ticket)) {
      logger.info(
        { ticketId: ticket.identifier, currentState: ticket.state.name },
        'Transitioning ticket from backlog to Up Next'
      );
      await linearClient.setIssueUpNext(ticket.id);
    }
  }

  async processTickets(tickets: TicketInfo[]): Promise<ProcessingResult[]> {
    const results: ProcessingResult[] = [];

    for (const ticket of tickets) {
      if (this.processing.has(ticket.id)) {
        continue;
      }

      try {
        const result = await this.processTicket(ticket);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        logger.error(
          { ticketId: ticket.identifier, error },
          'Error processing ticket'
        );
      }
    }

    return results;
  }

  private async processTicket(ticket: TicketInfo): Promise<ProcessingResult | null> {
    let state = ticketStateMachine.getState(ticket.id);

    if (!state) {
      state = this.initializeTicketState(ticket);
    }

    if (isTerminalState(state.currentState)) {
      return null;
    }

    if (requiresHumanInput(state.currentState)) {
      return this.checkForHumanResponse(ticket, state);
    }

    this.processing.add(ticket.id);

    try {
      return await this.executeWorkflow(ticket, state);
    } finally {
      this.processing.delete(ticket.id);
    }
  }

  private initializeTicketState(ticket: TicketInfo): TicketState {
    const hasTaskAgentLabel = ticket.labels.some(
      (l) => l.name === 'task-agent' || l.name.startsWith('ta:')
    );

    let initialState: TicketWorkflowState = 'new';

    if (hasTaskAgentLabel) {
      const labelName = ticket.labels.find((l) => l.name.startsWith('ta:'))?.name || 'task-agent';
      initialState = this.inferStateFromLabel(labelName);
    }

    return ticketStateMachine.initializeTicket(ticket.id, ticket.identifier, initialState);
  }

  private inferStateFromLabel(labelName: string): TicketWorkflowState {
    const labelToState: Record<string, TicketWorkflowState> = {
      'ta:evaluating': 'evaluating',
      'ta:needs-refinement': 'needs_refinement',
      'ta:refining': 'refining',
      'ta:awaiting-response': 'awaiting_response',
      'ta:pending-approval': 'ready_for_approval',
      'ta:approved': 'approved',
      'ta:generating-prompt': 'generating_prompt',
      'task-agent': 'executing',
      'ta:completed': 'completed',
      'ta:failed': 'failed',
      'ta:blocked': 'blocked',
    };
    return labelToState[labelName] || 'new';
  }

  private async executeWorkflow(
    ticket: TicketInfo,
    state: TicketState
  ): Promise<ProcessingResult | null> {
    const previousState = state.currentState;

    switch (state.currentState) {
      case 'new':
        return this.handleNewTicket(ticket, previousState);

      case 'evaluating':
        return this.handleEvaluating(ticket, previousState);

      case 'needs_refinement':
        return this.handleNeedsRefinement(ticket, previousState);

      case 'refining':
        return this.handleRefining(ticket, previousState);

      case 'approved':
        return this.handleApproved(ticket, previousState);

      case 'generating_prompt':
        return this.handleGeneratingPrompt(ticket, previousState);

      case 'executing':
        return this.handleExecuting(ticket, previousState);

      default:
        return null;
    }
  }

  private async handleNewTicket(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    if (ticket.assignee) {
      return this.createResult(ticket, previousState, previousState, 'skipped-assigned');
    }

    ticketStateMachine.transition(ticket.id, 'evaluating', 'Starting evaluation');
    await this.syncLabel(ticket.id, 'evaluating');

    return this.handleEvaluating(ticket, 'new');
  }

  private async handleEvaluating(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    logger.info({ ticketId: ticket.identifier }, 'Evaluating ticket readiness');

    const comments = await linearClient.getComments(ticket.id);

    const input: AgentInput<ReadinessScorerInput> = {
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      data: {
        title: ticket.title,
        description: ticket.description || '',
        priority: ticket.priority,
        labels: ticket.labels,
        state: ticket.state,
        comments: comments.map((c) => ({ body: c.body, createdAt: c.createdAt })),
      },
      context: { updatedAt: ticket.updatedAt },
    };

    const result = await readinessScorerAgent.execute(input);

    if (!result.success || !result.data) {
      logger.error({ ticketId: ticket.identifier, error: result.error }, 'Readiness evaluation failed');
      return this.createResult(ticket, previousState, 'evaluating', 'evaluation-failed');
    }

    const readiness = result.data;
    ticketStateMachine.storeAgentOutput(ticket.id, 'readiness-scorer', readiness);

    logger.info(
      { ticketId: ticket.identifier, score: readiness.score, action: readiness.recommendedAction },
      'Readiness evaluation complete'
    );

    if (readiness.recommendedAction === 'block') {
      ticketStateMachine.transition(ticket.id, 'blocked', readiness.reasoning, readiness);
      await this.syncLabel(ticket.id, 'blocked');
      return this.createResult(ticket, previousState, 'blocked', 'blocked');
    }

    if (readiness.score >= READINESS_THRESHOLD) {
      ticketStateMachine.transition(ticket.id, 'ready_for_approval', 'Score meets threshold', readiness);
      await this.syncLabel(ticket.id, 'ready_for_approval');
      // Transition from backlog to Up Next before requesting approval
      await this.transitionFromBacklogIfNeeded(ticket);
      await this.requestApproval(ticket, readiness);
      return this.createResult(ticket, previousState, 'ready_for_approval', 'approval-requested');
    }

    ticketStateMachine.transition(ticket.id, 'needs_refinement', 'Score below threshold', readiness);
    await this.syncLabel(ticket.id, 'needs_refinement');
    return this.handleNeedsRefinement(ticket, 'evaluating');
  }

  private async handleNeedsRefinement(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    ticketStateMachine.transition(ticket.id, 'refining', 'Starting refinement');
    await this.syncLabel(ticket.id, 'refining');
    return this.handleRefining(ticket, previousState);
  }

  private async handleRefining(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    logger.info({ ticketId: ticket.identifier }, 'Refining ticket');

    const readiness = ticketStateMachine.getAgentOutput<ReadinessScorerOutput>(
      ticket.id,
      'readiness-scorer'
    );

    if (!readiness) {
      ticketStateMachine.transition(ticket.id, 'evaluating', 'Missing readiness data');
      return this.createResult(ticket, previousState, 'evaluating', 'missing-readiness');
    }

    const comments = await linearClient.getComments(ticket.id);

    const input: AgentInput<TicketRefinerInput> = {
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      data: {
        title: ticket.title,
        description: ticket.description || '',
        readinessResult: readiness,
        existingComments: comments.map((c) => ({
          body: c.body,
          createdAt: c.createdAt,
          isFromTaskAgent: isTaskAgentComment(c.user),
        })),
      },
    };

    const result = await ticketRefinerAgent.execute(input);

    if (!result.success || !result.data) {
      logger.error({ ticketId: ticket.identifier, error: result.error }, 'Refinement failed');
      return this.createResult(ticket, previousState, 'refining', 'refinement-failed');
    }

    const refinement = result.data;
    ticketStateMachine.storeAgentOutput(ticket.id, 'ticket-refiner', refinement);

    if (refinement.action === 'ready') {
      ticketStateMachine.transition(ticket.id, 'ready_for_approval', 'Refiner marked ready');
      await this.syncLabel(ticket.id, 'ready_for_approval');
      // Transition from backlog to Up Next before requesting approval
      await this.transitionFromBacklogIfNeeded(ticket);
      await this.requestApproval(ticket, readiness);
      return this.createResult(ticket, previousState, 'ready_for_approval', 'ready-after-refinement');
    }

    if (refinement.action === 'blocked') {
      ticketStateMachine.transition(ticket.id, 'blocked', refinement.blockerReason);
      await this.syncLabel(ticket.id, 'blocked');
      return this.createResult(ticket, previousState, 'blocked', 'blocked-by-refiner');
    }

    const mentionPrefix = await this.formatLeadMention();
    const formattedQuestions = ticketRefinerAgent.formatQuestionsForLinear(
      refinement,
      ticket.identifier,
      mentionPrefix
    );

    if (formattedQuestions) {
      await linearClient.addComment(ticket.id, formattedQuestions);
      ticketStateMachine.transition(ticket.id, 'awaiting_response', 'Questions posted');
      await this.syncLabel(ticket.id, 'awaiting_response');
      return this.createResult(ticket, previousState, 'awaiting_response', 'questions-posted');
    }

    ticketStateMachine.transition(ticket.id, 'ready_for_approval', 'No questions needed');
    await this.syncLabel(ticket.id, 'ready_for_approval');
    // Transition from backlog to Up Next before requesting approval
    await this.transitionFromBacklogIfNeeded(ticket);
    await this.requestApproval(ticket, readiness);
    return this.createResult(ticket, previousState, 'ready_for_approval', 'ready-no-questions');
  }

  private async handleApproved(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    // Check if we've hit the max code executors limit
    const executingCount = codeExecutorAgent.getRunningCount();
    if (executingCount >= config.agents.maxCodeExecutors) {
      logger.debug(
        { ticketId: ticket.identifier, executingCount, max: config.agents.maxCodeExecutors },
        'Max code executors reached, waiting'
      );
      return this.createResult(ticket, previousState, 'approved', 'waiting-for-executor-slot');
    }

    ticketStateMachine.transition(ticket.id, 'generating_prompt', 'Starting prompt generation');
    await this.syncLabel(ticket.id, 'generating_prompt');
    return this.handleGeneratingPrompt(ticket, previousState);
  }

  private async handleGeneratingPrompt(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    logger.info({ ticketId: ticket.identifier }, 'Generating prompt');

    const input: AgentInput<PromptGeneratorInput> = {
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      data: {
        ticket: {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || '',
        },
        constraints: {
          branchNaming: `task-agent/${ticket.identifier.toLowerCase()}`,
        },
      },
      context: { updatedAt: ticket.updatedAt },
    };

    const result = await promptGeneratorAgent.execute(input);

    if (!result.success || !result.data) {
      logger.error({ ticketId: ticket.identifier, error: result.error }, 'Prompt generation failed');
      ticketStateMachine.transition(ticket.id, 'failed', result.error || 'Prompt generation failed');
      await this.syncLabel(ticket.id, 'failed');
      return this.createResult(ticket, previousState, 'failed', 'prompt-generation-failed');
    }

    ticketStateMachine.storeAgentOutput(ticket.id, 'prompt-generator', result.data);

    ticketStateMachine.transition(ticket.id, 'executing', 'Prompt generated');
    await this.syncLabel(ticket.id, 'executing');

    // Set the Linear issue state to "In Progress"
    await linearClient.setIssueInProgress(ticket.id);

    // Create an agent session for real-time visibility in Linear UI
    const session = await linearClient.createAgentSession(ticket.id);
    if (session) {
      agentSessions.set(ticket.id, session.id);
      // Post initial activity
      await linearClient.addAgentActivity(session.id, 'thought', {
        message: 'Starting work on this ticket...',
      });
    }

    return this.handleExecuting(ticket, 'generating_prompt');
  }

  private async handleExecuting(
    ticket: TicketInfo,
    previousState: TicketWorkflowState
  ): Promise<ProcessingResult> {
    logger.info({ ticketId: ticket.identifier }, 'Executing code changes');

    const promptOutput = ticketStateMachine.getAgentOutput<{ prompt: string }>(
      ticket.id,
      'prompt-generator'
    );

    if (!promptOutput) {
      logger.error({ ticketId: ticket.identifier }, 'Missing prompt output');
      ticketStateMachine.transition(ticket.id, 'generating_prompt', 'Missing prompt');
      return this.createResult(ticket, previousState, 'generating_prompt', 'missing-prompt');
    }

    // Get agent session if available
    const sessionId = agentSessions.get(ticket.id);

    // Update agent activity to show we're executing
    if (sessionId) {
      await linearClient.addAgentActivity(sessionId, 'action', {
        action: 'executing',
        parameter: 'Running Claude Code agent',
      });
    }

    const worktree = await worktreeManager.create(ticket.identifier);

    const result = await codeExecutorAgent.execute({
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      data: {
        ticketIdentifier: ticket.identifier,
        prompt: promptOutput.prompt,
        worktreePath: worktree.path,
        branchName: worktree.branch,
      },
    });

    await worktreeManager.remove(ticket.identifier);

    if (!result.success || !result.data?.success) {
      const error = result.error || result.data?.error || 'Execution failed';
      logger.error({ ticketId: ticket.identifier, error }, 'Code execution failed');

      const retryCount = (ticketStateMachine.getMetadata(ticket.id, 'retryCount') as number) || 0;

      if (retryCount < config.agents.maxRetries) {
        ticketStateMachine.setMetadata(ticket.id, 'retryCount', retryCount + 1);

        // Update agent activity to show retry
        if (sessionId) {
          await linearClient.addAgentActivity(sessionId, 'thought', {
            message: `Attempt ${retryCount + 1} failed: ${error}. Retrying...`,
          });
        }

        await linearClient.addComment(
          ticket.id,
          `Attempt ${retryCount + 1} failed: ${error}\n\nRetrying...`
        );
        return this.createResult(ticket, previousState, 'executing', 'retrying');
      }

      ticketStateMachine.transition(ticket.id, 'failed', error);
      await this.syncLabel(ticket.id, 'failed');

      // Mark agent session as errored
      if (sessionId) {
        await linearClient.errorAgentSession(sessionId, `Failed after ${retryCount + 1} attempts: ${error}`);
        agentSessions.delete(ticket.id);
      }

      await linearClient.addComment(
        ticket.id,
        `Failed after ${retryCount + 1} attempts.\n\n**Error**: ${error}\n\nEscalating for human review.`
      );
      return this.createResult(ticket, previousState, 'failed', 'execution-failed');
    }

    ticketStateMachine.storeAgentOutput(ticket.id, 'code-executor', result.data);
    ticketStateMachine.transition(ticket.id, 'completed', 'Execution successful');
    await this.syncLabel(ticket.id, 'completed');

    // Set the Linear issue state to "Done"
    await linearClient.setIssueDone(ticket.id);

    // Complete the agent session
    if (sessionId) {
      const summary = result.data.prUrl
        ? `Work completed. PR: ${result.data.prUrl}`
        : 'Work completed successfully';
      await linearClient.completeAgentSession(sessionId, summary);
      agentSessions.delete(ticket.id);
    }

    let comment = `Work completed successfully!`;
    if (result.data.prUrl) {
      comment += `\n\n**Pull Request**: ${result.data.prUrl}`;
    }
    await linearClient.addComment(ticket.id, comment);

    return this.createResult(ticket, previousState, 'completed', 'completed');
  }

  private async checkForHumanResponse(
    ticket: TicketInfo,
    state: TicketState
  ): Promise<ProcessingResult | null> {
    const comments = await linearClient.getComments(ticket.id);

    if (state.currentState === 'awaiting_response') {
      const lastAgentComment = this.findLastAgentComment(comments);
      if (!lastAgentComment) return null;

      const hasHumanResponse = comments.some(
        (c) => !isTaskAgentComment(c.user) &&
          c.createdAt > lastAgentComment.createdAt
      );

      if (hasHumanResponse) {
        ticketStateMachine.transition(ticket.id, 'evaluating', 'Human response received');
        await this.syncLabel(ticket.id, 'evaluating');
        return this.createResult(ticket, 'awaiting_response', 'evaluating', 'response-received');
      }
    }

    if (state.currentState === 'ready_for_approval') {
      const approvalComment = comments.find(
        (c) => isTaskAgentComment(c.user) && c.body.includes('React with 👍 to approve')
      );

      if (!approvalComment) return null;

      const response = this.findApprovalResponse(comments, approvalComment.createdAt);

      if (response === 'approved') {
        ticketStateMachine.transition(ticket.id, 'approved', 'Human approved');
        await this.syncLabel(ticket.id, 'approved');
        return this.createResult(ticket, 'ready_for_approval', 'approved', 'approved');
      }

      if (response === 'rejected') {
        ticketStateMachine.transition(ticket.id, 'new', 'Human rejected');
        await this.syncLabel(ticket.id, 'new');
        return this.createResult(ticket, 'ready_for_approval', 'new', 'rejected');
      }
    }

    return null;
  }

  private findLastAgentComment(comments: TicketComment[]): TicketComment | undefined {
    return comments
      .filter((c) => isTaskAgentComment(c.user))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  private findApprovalResponse(
    comments: TicketComment[],
    proposalTime: Date
  ): 'approved' | 'rejected' | null {
    const sortedComments = comments.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    for (const comment of sortedComments) {
      if (comment.user?.isMe) continue;
      if (comment.createdAt <= proposalTime) continue;

      const body = comment.body.toLowerCase().trim();

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

  private async requestApproval(
    ticket: TicketInfo,
    readiness: ReadinessScorerOutput
  ): Promise<void> {
    const mentionPrefix = await this.formatLeadMention();
    const commentBody = `${mentionPrefix}I'd like to start working on this ticket. Here's my analysis:

**Readiness Score**: ${readiness.score}/100
**Assessment**: ${readiness.reasoning}

${readiness.issues.length > 0 ? `**Potential Issues**:\n${readiness.issues.map((i) => `- ${i}`).join('\n')}` : ''}

${readiness.suggestions.length > 0 ? `**Suggestions**:\n${readiness.suggestions.map((s) => `- ${s}`).join('\n')}` : ''}

---
React with 👍 to approve or 👎 to skip.`;

    await linearClient.addComment(ticket.id, commentBody);
    logger.info({ ticketId: ticket.identifier }, 'Approval requested');
  }

  private async syncLabel(ticketId: string, newState: TicketWorkflowState): Promise<void> {
    const allLabels = Object.values(LINEAR_LABELS).filter((l): l is string => l !== null);

    for (const label of allLabels) {
      try {
        await linearClient.removeLabel(ticketId, label);
      } catch {
        // Ignore errors when removing non-existent labels
      }
    }

    const newLabel = LINEAR_LABELS[newState];
    if (newLabel) {
      await linearClient.addLabel(ticketId, newLabel);
    }
  }

  private createResult(
    ticket: TicketInfo,
    previousState: TicketWorkflowState,
    newState: TicketWorkflowState,
    action: string
  ): ProcessingResult {
    return {
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      previousState,
      newState,
      action,
    };
  }

  getStats(): {
    stateDistribution: Record<TicketWorkflowState, number>;
    activeCount: number;
    processingCount: number;
  } {
    return {
      stateDistribution: ticketStateMachine.getStats(),
      activeCount: ticketStateMachine.getActiveTickets().length,
      processingCount: this.processing.size,
    };
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down workflow engine');
    codeExecutorAgent.killAllProcesses();
  }
}

export const workflowEngine = new WorkflowEngine();
