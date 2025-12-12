import { createChildLogger } from '../utils/logger.js';
import { linearQueue, type LinearQueueItem } from './linear-queue.js';
import { claudeQueue, type ClaudeQueueItem } from './claude-queue.js';
import { queueScheduler } from './scheduler.js';
import { linearClient, RateLimitError } from '../linear/client.js';
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

const logger = createChildLogger({ module: 'queue-processor' });

const READINESS_THRESHOLD = 70;
const TASK_AGENT_TAG = '[TaskAgent]';
const APPROVAL_TAG = '[TaskAgent Proposal]';
const WORKING_TAG = '[TaskAgent Working]';

// Track agent sessions per ticket
const agentSessions = new Map<string, string>();

export interface ProcessorCallbacks {
  onStateChange?: (ticketId: string, newState: string, data?: Record<string, unknown>) => void;
  onError?: (ticketId: string, error: string) => void;
}

/**
 * QueueProcessor handles the actual processing of tasks from both queues.
 * It extracts the workflow logic into task-based handlers.
 */
export class QueueProcessor {
  private callbacks: ProcessorCallbacks = {};
  private running = false;
  private processingInterval: NodeJS.Timeout | null = null;

  setCallbacks(callbacks: ProcessorCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Start processing queues at regular intervals
   */
  start(intervalMs = 1000): void {
    if (this.running) {
      logger.warn('Processor already running');
      return;
    }

    this.running = true;
    logger.info({ intervalMs }, 'Starting queue processor');

    // Process immediately, then on interval
    this.processOnce();
    this.processingInterval = setInterval(() => {
      this.processOnce();
    }, intervalMs);
  }

  /**
   * Stop processing
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    this.running = false;
    logger.info('Queue processor stopped');
  }

  /**
   * Process one item from each queue (if available)
   */
  async processOnce(): Promise<void> {
    // Skip linear queue processing if rate limited
    if (linearClient.isRateLimited()) {
      const resetAt = linearClient.getRateLimitResetAt();
      logger.debug({ resetAt: resetAt?.toLocaleTimeString() }, 'Skipping linear tasks - rate limited');
    } else {
      // Process linear queue tasks
      const linearTask = linearQueue.dequeue();
      if (linearTask) {
        await this.processLinearTask(linearTask);
      }
    }

    // Process claude queue tasks (respects concurrency)
    const claudePending = claudeQueue.getPendingCount();
    const claudeProcessing = claudeQueue.getProcessingCount();
    if (claudePending > 0 || claudeProcessing > 0) {
      logger.debug(
        { pending: claudePending, processing: claudeProcessing },
        'Claude queue status before dequeue'
      );
    }

    const claudeTask = claudeQueue.dequeue();
    if (claudeTask) {
      await this.processClaudeTask(claudeTask);
    }
  }

  /**
   * Process a linear ticket task
   */
  private async processLinearTask(task: LinearQueueItem): Promise<void> {
    logger.info(
      { ticketId: task.ticketIdentifier, taskType: task.taskType, id: task.id },
      'Processing linear task'
    );

    try {
      switch (task.taskType) {
        case 'evaluate':
          await this.handleEvaluate(task);
          break;
        case 'refine':
          await this.handleRefine(task);
          break;
        case 'check_response':
          await this.handleCheckResponse(task);
          break;
        case 'generate_prompt':
          await this.handleGeneratePrompt(task);
          break;
        case 'sync_state':
          await this.handleSyncState(task);
          break;
        default:
          logger.error({ taskType: task.taskType }, 'Unknown task type');
          linearQueue.fail(task.id, `Unknown task type: ${task.taskType}`);
      }
    } catch (error) {
      // Handle rate limit errors specially - don't count as task failure
      if (error instanceof RateLimitError) {
        logger.warn(
          { taskId: task.id, ticketId: task.ticketIdentifier, resetAt: error.resetAt.toLocaleTimeString() },
          'Task hit rate limit, requeueing without penalty'
        );
        // Requeue without incrementing retry count
        linearQueue.requeueForRateLimit(task.id);
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(
        {
          taskId: task.id,
          ticketId: task.ticketIdentifier,
          taskType: task.taskType,
          error: errorMessage,
          stack: errorStack,
        },
        'Task processing failed'
      );
      linearQueue.fail(task.id, errorMessage);
      this.callbacks.onError?.(task.ticketId, errorMessage);
    }
  }

  /**
   * Process a Claude code execution task
   */
  private async processClaudeTask(task: ClaudeQueueItem): Promise<void> {
    logger.info(
      { ticketId: task.ticketIdentifier, id: task.id },
      'Processing execution task'
    );

    try {
      await this.handleExecution(task);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(
        {
          taskId: task.id,
          ticketId: task.ticketIdentifier,
          error: errorMessage,
          stack: errorStack,
        },
        'Execution processing failed'
      );
      const willRetry = claudeQueue.fail(task.id, errorMessage);

      if (!willRetry) {
        // Mark agent session as errored if we have one
        if (task.agentSessionId) {
          await linearClient.errorAgentSession(task.agentSessionId, errorMessage);
        }
      }

      this.callbacks.onError?.(task.ticketId, errorMessage);
    }
  }

  // ============================================================
  // Task Handlers
  // ============================================================

  private async handleEvaluate(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicket(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    const comments = await linearClient.getComments(task.ticketId);

    const input: AgentInput<ReadinessScorerInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
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
      linearQueue.fail(task.id, result.error || 'Evaluation failed');
      return;
    }

    const readiness = result.data;

    logger.info(
      { ticketId: task.ticketIdentifier, score: readiness.score, action: readiness.recommendedAction },
      'Evaluation complete'
    );

    // Complete this task with output
    linearQueue.complete(task.id, readiness);

    // Determine next action based on readiness
    if (readiness.recommendedAction === 'block') {
      await this.syncLabel(task.ticketId, 'ta:blocked');
      this.callbacks.onStateChange?.(task.ticketId, 'blocked', readiness);
      return;
    }

    if (readiness.score >= READINESS_THRESHOLD) {
      // Ready for approval - request it
      await this.requestApproval(task, readiness);
      await this.syncLabel(task.ticketId, 'ta:pending-approval');
      this.callbacks.onStateChange?.(task.ticketId, 'ready_for_approval', readiness);

      // Register that we're waiting for approval (scheduler will check periodically)
      queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'approval');

      // Enqueue initial response check (will be followed up by scheduler)
      linearQueue.enqueue({
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        taskType: 'check_response',
        priority: task.priority,
        readinessScore: readiness.score,
        inputData: { waitingFor: 'approval', readiness },
      });
    } else {
      // Needs refinement
      await this.syncLabel(task.ticketId, 'ta:needs-refinement');
      this.callbacks.onStateChange?.(task.ticketId, 'needs_refinement', readiness);

      // Enqueue refinement task
      linearQueue.enqueue({
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        taskType: 'refine',
        priority: task.priority,
        readinessScore: readiness.score,
        inputData: { readiness },
      });
    }
  }

  private async handleRefine(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicket(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    const readiness = task.inputData?.readiness as ReadinessScorerOutput | undefined;
    if (!readiness) {
      // Need to re-evaluate first
      linearQueue.enqueue({
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        taskType: 'evaluate',
        priority: task.priority,
      });
      linearQueue.complete(task.id, { reason: 'missing_readiness' });
      return;
    }

    const comments = await linearClient.getComments(task.ticketId);

    const input: AgentInput<TicketRefinerInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        title: ticket.title,
        description: ticket.description || '',
        readinessResult: readiness,
        existingComments: comments.map((c) => ({
          body: c.body,
          createdAt: c.createdAt,
          isFromTaskAgent: c.user?.isMe || c.body.includes(TASK_AGENT_TAG),
        })),
      },
    };

    const result = await ticketRefinerAgent.execute(input);

    if (!result.success || !result.data) {
      linearQueue.fail(task.id, result.error || 'Refinement failed');
      return;
    }

    const refinement = result.data;
    linearQueue.complete(task.id, refinement);

    if (refinement.action === 'ready') {
      await this.requestApproval(task, readiness);
      await this.syncLabel(task.ticketId, 'ta:pending-approval');
      this.callbacks.onStateChange?.(task.ticketId, 'ready_for_approval');

      // Register that we're waiting for approval
      queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'approval');

      linearQueue.enqueue({
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        taskType: 'check_response',
        priority: task.priority,
        readinessScore: readiness.score,
        inputData: { waitingFor: 'approval', readiness },
      });
    } else if (refinement.action === 'blocked') {
      await this.syncLabel(task.ticketId, 'ta:blocked');
      this.callbacks.onStateChange?.(task.ticketId, 'blocked', { reason: refinement.blockerReason });
    } else {
      // Post questions - but first check if we've already asked questions without getting a response
      const hasUnansweredQuestions = this.hasUnansweredQuestions(comments);

      if (hasUnansweredQuestions) {
        logger.info(
          { ticketId: task.ticketIdentifier },
          'Already have unanswered questions, skipping duplicate comment'
        );
        // Still set the label and register for response checking
        await this.syncLabel(task.ticketId, 'ta:awaiting-response');
        queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'questions');

        linearQueue.enqueue({
          ticketId: task.ticketId,
          ticketIdentifier: task.ticketIdentifier,
          taskType: 'check_response',
          priority: task.priority,
          readinessScore: readiness.score,
          inputData: { waitingFor: 'questions', readiness },
        });
      } else {
        // Post questions as individual comments
        const questionComments = ticketRefinerAgent.formatQuestionsAsComments(refinement);

        if (questionComments.length > 0) {
          // Post each question as a separate comment for easy reply
          for (const comment of questionComments) {
            await linearClient.addComment(task.ticketId, comment);
          }

          await this.syncLabel(task.ticketId, 'ta:awaiting-response');
          this.callbacks.onStateChange?.(task.ticketId, 'awaiting_response');

          // Register that we're waiting for questions (scheduler will check periodically)
          queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'questions');

          linearQueue.enqueue({
            ticketId: task.ticketId,
            ticketIdentifier: task.ticketIdentifier,
            taskType: 'check_response',
            priority: task.priority,
            readinessScore: readiness.score,
            inputData: { waitingFor: 'questions', readiness },
          });
        }
      }
    }
  }

  private async handleCheckResponse(task: LinearQueueItem): Promise<void> {
    const comments = await linearClient.getComments(task.ticketId);
    const waitingFor = task.inputData?.waitingFor as string;

    logger.debug(
      { ticketId: task.ticketIdentifier, waitingFor, commentCount: comments.length },
      'Checking for response'
    );

    if (waitingFor === 'approval') {
      const response = this.findApprovalResponse(comments);

      logger.info(
        { ticketId: task.ticketIdentifier, response: response || 'none' },
        'Approval check result'
      );

      if (response === 'approved') {
        // Clear from awaiting response since we got a response
        queueScheduler.clearAwaitingResponse(task.ticketId);

        linearQueue.complete(task.id, { response: 'approved' });
        await this.syncLabel(task.ticketId, 'ta:approved');
        this.callbacks.onStateChange?.(task.ticketId, 'approved');

        // Enqueue prompt generation
        linearQueue.enqueue({
          ticketId: task.ticketId,
          ticketIdentifier: task.ticketIdentifier,
          taskType: 'generate_prompt',
          priority: task.priority,
          readinessScore: task.readinessScore ?? undefined,
          inputData: task.inputData ?? undefined,
        });
      } else if (response === 'rejected') {
        // Clear from awaiting response since we got a response
        queueScheduler.clearAwaitingResponse(task.ticketId);

        linearQueue.complete(task.id, { response: 'rejected' });
        await this.syncLabel(task.ticketId, null); // Remove label
        this.callbacks.onStateChange?.(task.ticketId, 'new');
      } else {
        // No response yet - complete without action, scheduler will re-enqueue later
        linearQueue.complete(task.id, { response: 'none' });
      }
    } else if (waitingFor === 'questions') {
      // Check if there's a human response after our questions
      const lastAgentComment = comments
        .filter((c) => c.user?.isMe || c.body.includes(TASK_AGENT_TAG))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      if (lastAgentComment) {
        const hasHumanResponse = comments.some(
          (c) =>
            !c.user?.isMe &&
            !c.body.includes(TASK_AGENT_TAG) &&
            c.createdAt > lastAgentComment.createdAt
        );

        if (hasHumanResponse) {
          // Clear from awaiting response since we got a response
          queueScheduler.clearAwaitingResponse(task.ticketId);

          linearQueue.complete(task.id, { response: 'received' });

          // Re-evaluate with new information
          linearQueue.enqueue({
            ticketId: task.ticketId,
            ticketIdentifier: task.ticketIdentifier,
            taskType: 'evaluate',
            priority: task.priority,
          });
          this.callbacks.onStateChange?.(task.ticketId, 'evaluating');
        } else {
          // No response yet - complete without action, scheduler will re-enqueue later
          linearQueue.complete(task.id, { response: 'none' });
        }
      }
    }
  }

  private async handleGeneratePrompt(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicket(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    await this.syncLabel(task.ticketId, 'ta:generating-prompt');

    const input: AgentInput<PromptGeneratorInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        ticket: {
          identifier: task.ticketIdentifier,
          title: ticket.title,
          description: ticket.description || '',
        },
        constraints: {
          branchNaming: `task-agent/${task.ticketIdentifier.toLowerCase()}`,
        },
      },
      context: { updatedAt: ticket.updatedAt },
    };

    const result = await promptGeneratorAgent.execute(input);

    if (!result.success || !result.data) {
      linearQueue.fail(task.id, result.error || 'Prompt generation failed');
      await this.syncLabel(task.ticketId, 'ta:failed');
      this.callbacks.onStateChange?.(task.ticketId, 'failed');
      return;
    }

    linearQueue.complete(task.id, result.data);

    // Set issue to In Progress
    await linearClient.setIssueInProgress(task.ticketId);
    await this.syncLabel(task.ticketId, 'task-agent');

    // Create agent session
    const session = await linearClient.createAgentSession(task.ticketId);
    if (session) {
      agentSessions.set(task.ticketId, session.id);
      await linearClient.addAgentActivity(session.id, 'thought', {
        message: 'Starting work on this ticket...',
      });
    }

    await linearClient.addComment(task.ticketId, `${WORKING_TAG}\n\nStarting work on this ticket...`);

    // Create worktree and enqueue execution
    const worktree = await worktreeManager.create(task.ticketIdentifier);

    logger.info(
      { ticketId: task.ticketIdentifier, worktreePath: worktree.path, branchName: worktree.branch },
      'Enqueueing Claude Code execution'
    );

    const enqueuedTask = claudeQueue.enqueue({
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      priority: task.priority,
      readinessScore: task.readinessScore ?? undefined,
      prompt: result.data.prompt,
      worktreePath: worktree.path,
      branchName: worktree.branch,
      agentSessionId: session?.id,
    });

    if (enqueuedTask) {
      logger.info(
        { ticketId: task.ticketIdentifier, taskId: enqueuedTask.id },
        'Successfully enqueued Claude Code execution'
      );
    } else {
      logger.error(
        { ticketId: task.ticketIdentifier },
        'Failed to enqueue Claude Code execution - task may already exist'
      );
    }

    this.callbacks.onStateChange?.(task.ticketId, 'executing');
  }

  private async handleSyncState(task: LinearQueueItem): Promise<void> {
    const state = task.inputData?.state as string;
    const label = task.inputData?.label as string | null;

    if (label !== undefined) {
      await this.syncLabel(task.ticketId, label);
    }

    linearQueue.complete(task.id, { synced: true });
    this.callbacks.onStateChange?.(task.ticketId, state);
  }

  private async handleExecution(task: ClaudeQueueItem): Promise<void> {
    if (!task.prompt || !task.worktreePath || !task.branchName) {
      claudeQueue.fail(task.id, 'Missing execution parameters');
      return;
    }

    // Update agent activity
    if (task.agentSessionId) {
      await linearClient.addAgentActivity(task.agentSessionId, 'action', {
        action: 'executing',
        parameter: 'Running Claude Code agent',
      });
    }

    const result = await codeExecutorAgent.execute({
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        ticketIdentifier: task.ticketIdentifier,
        prompt: task.prompt,
        worktreePath: task.worktreePath,
        branchName: task.branchName,
      },
    });

    // Clean up worktree
    await worktreeManager.remove(task.ticketIdentifier);

    if (!result.success || !result.data?.success) {
      const error = result.error || result.data?.error || 'Execution failed';

      // Update agent activity with error
      if (task.agentSessionId) {
        await linearClient.addAgentActivity(task.agentSessionId, 'thought', {
          message: `Attempt ${task.retryCount + 1} failed: ${error}`,
        });
      }

      const willRetry = claudeQueue.fail(task.id, error);

      if (!willRetry) {
        await this.syncLabel(task.ticketId, 'ta:failed');
        if (task.agentSessionId) {
          await linearClient.errorAgentSession(task.agentSessionId, error);
          agentSessions.delete(task.ticketId);
        }
        await linearClient.addComment(
          task.ticketId,
          `${TASK_AGENT_TAG} Failed after ${task.retryCount + 1} attempts.\n\n**Error**: ${error}\n\nEscalating for human review.`
        );
        this.callbacks.onStateChange?.(task.ticketId, 'failed', { error });
      } else {
        await linearClient.addComment(
          task.ticketId,
          `${TASK_AGENT_TAG} Attempt ${task.retryCount + 1} failed: ${error}\n\nRetrying...`
        );
      }
      return;
    }

    // Success!
    claudeQueue.complete(task.id, result.data.prUrl ?? undefined);

    await linearClient.setIssueDone(task.ticketId);
    await this.syncLabel(task.ticketId, 'ta:completed');

    if (task.agentSessionId) {
      const summary = result.data.prUrl
        ? `Work completed. PR: ${result.data.prUrl}`
        : 'Work completed successfully';
      await linearClient.completeAgentSession(task.agentSessionId, summary);
      agentSessions.delete(task.ticketId);
    }

    let comment = `${TASK_AGENT_TAG} Work completed successfully!`;
    if (result.data.prUrl) {
      comment += `\n\n**Pull Request**: ${result.data.prUrl}`;
    }
    await linearClient.addComment(task.ticketId, comment);

    this.callbacks.onStateChange?.(task.ticketId, 'completed', { prUrl: result.data.prUrl });
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  private async syncLabel(ticketId: string, newLabel: string | null): Promise<void> {
    const allLabels = [
      'ta:evaluating',
      'ta:needs-refinement',
      'ta:refining',
      'ta:awaiting-response',
      'ta:pending-approval',
      'ta:approved',
      'ta:generating-prompt',
      'task-agent',
      'ta:completed',
      'ta:failed',
      'ta:blocked',
    ];

    for (const label of allLabels) {
      try {
        await linearClient.removeLabel(ticketId, label);
      } catch {
        // Ignore errors when removing non-existent labels
      }
    }

    if (newLabel) {
      await linearClient.addLabel(ticketId, newLabel);
    }
  }

  private async requestApproval(
    task: LinearQueueItem,
    readiness: ReadinessScorerOutput
  ): Promise<void> {
    // Check if we've already requested approval
    const comments = await linearClient.getComments(task.ticketId);
    const hasExistingApprovalRequest = comments.some(
      (c) => c.body.includes(APPROVAL_TAG) && c.user?.isMe
    );

    if (hasExistingApprovalRequest) {
      logger.info({ ticketId: task.ticketIdentifier }, 'Approval already requested, skipping duplicate comment');
      return;
    }

    const commentBody = `${APPROVAL_TAG}

I'd like to start working on this ticket. Here's my analysis:

**Readiness Score**: ${readiness.score}/100
**Assessment**: ${readiness.reasoning}

${readiness.issues.length > 0 ? `**Potential Issues**:\n${readiness.issues.map((i) => `- ${i}`).join('\n')}` : ''}

${readiness.suggestions.length > 0 ? `**Suggestions**:\n${readiness.suggestions.map((s) => `- ${s}`).join('\n')}` : ''}

---
Reply with **"yes"** or **"approve"** to start, or **"no"** to skip this ticket.`;

    await linearClient.addComment(task.ticketId, commentBody);
    logger.info({ ticketId: task.ticketIdentifier }, 'Approval requested');
  }

  private findApprovalResponse(
    comments: Array<{ body: string; createdAt: Date; user: { isMe: boolean } | null }>
  ): 'approved' | 'rejected' | null {
    // Find the approval proposal comment
    const proposalComment = comments.find(
      (c) => c.body.includes(APPROVAL_TAG) && c.user?.isMe
    );

    if (!proposalComment) {
      // Also check by tag if isMe isn't set (webhook comments may not have it)
      const proposalByTag = comments.find(
        (c) => c.body.includes(APPROVAL_TAG)
      );
      if (!proposalByTag) {
        logger.debug('No approval proposal comment found');
        return null;
      }
      // Use the tag-based match if isMe check didn't find it
      logger.debug('Found approval proposal by tag (not isMe check)');
    }

    const effectiveProposal = proposalComment || comments.find((c) => c.body.includes(APPROVAL_TAG))!;

    logger.debug(
      { proposalCreatedAt: effectiveProposal.createdAt },
      'Found approval proposal'
    );

    // Check responses after the proposal
    const sortedComments = comments.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    for (const comment of sortedComments) {
      // Skip our own comments (by isMe or by tag)
      if (comment.user?.isMe) continue;
      if (comment.body.includes(TASK_AGENT_TAG) || comment.body.includes(APPROVAL_TAG)) continue;
      if (comment.createdAt <= effectiveProposal.createdAt) continue;

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

  /**
   * Check if we've already posted questions that haven't been answered yet
   */
  private hasUnansweredQuestions(
    comments: Array<{ body: string; createdAt: Date; user: { isMe: boolean } | null }>
  ): boolean {
    // Find the most recent TaskAgent question comment (identified by emoji markers)
    const sortedComments = [...comments].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    // Question comments use emoji markers: ❗ (critical), ❓ (important), 💭 (nice to have)
    const lastQuestionComment = sortedComments.find(
      (c) => c.user?.isMe && c.body.includes(TASK_AGENT_TAG) && (
        c.body.includes('❗') || c.body.includes('❓') || c.body.includes('💭')
      )
    );

    if (!lastQuestionComment) {
      return false;
    }

    // Check if there are any non-TaskAgent comments after the question
    const hasResponseAfterQuestion = sortedComments.some(
      (c) => !c.user?.isMe && c.createdAt > lastQuestionComment.createdAt
    );

    // If there's no response after our questions, we have unanswered questions
    return !hasResponseAfterQuestion;
  }
}

export const queueProcessor = new QueueProcessor();
