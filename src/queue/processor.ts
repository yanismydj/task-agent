import { createChildLogger } from '../utils/logger.js';
import { linearQueue, type LinearQueueItem } from './linear-queue.js';
import { claudeQueue, type ClaudeQueueItem } from './claude-queue.js';
import { queueScheduler } from './scheduler.js';
import { linearClient, RateLimitError } from '../linear/client.js';
import { worktreeManager } from '../agents/worktree.js';
import { buildCodebaseContext } from '../utils/codebase-context.js';
import { config } from '../config.js';
import {
  readinessScorerAgent,
  ticketRefinerAgent,
  promptGeneratorAgent,
  codeExecutorAgent,
  descriptionConsolidatorAgent,
} from '../agents/impl/index.js';
import type {
  AgentInput,
  ReadinessScorerInput,
  ReadinessScorerOutput,
  TicketRefinerInput,
  PromptGeneratorInput,
} from '../agents/core/index.js';

const logger = createChildLogger({ module: 'queue-processor' });

// Note: We always go through refinement now - the refiner decides if questions are needed
const TASK_AGENT_TAG = '[TaskAgent]';
const TASK_AGENT_TAG_ESCAPED = '\\[TaskAgent\\]'; // Markdown-escaped version
const APPROVAL_TAG = '[TaskAgent Proposal]';
const WORKING_TAG = '[TaskAgent Working]';

// Helper to check if a comment body contains TaskAgent tags (handles both escaped and unescaped)
function hasTaskAgentTag(body: string): boolean {
  return body.includes(TASK_AGENT_TAG) || body.includes(TASK_AGENT_TAG_ESCAPED);
}

// Track agent sessions per ticket
const agentSessions = new Map<string, string>();

// Track tickets with pending approval requests (in-memory, persists across rate limit retries)
const pendingApprovalRequests = new Set<string>();

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
      logger.info(
        { ticketId: claudeTask.ticketIdentifier, taskId: claudeTask.id },
        'Dequeued Claude task, starting execution'
      );
      await this.processClaudeTask(claudeTask);
      logger.info(
        { ticketId: claudeTask.ticketIdentifier, taskId: claudeTask.id },
        'Claude task execution completed'
      );
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
    // Use cache-first lookup to reduce API calls
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    // Use cached comments if available
    const comments = await linearClient.getCommentsCached(task.ticketId);

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

    // Always go through refinement first - let the refiner decide if questions are needed
    // or if we should proceed directly to approval. This ensures consistent flow.
    await this.syncLabel(task.ticketId, 'ta:needs-refinement');
    this.callbacks.onStateChange?.(task.ticketId, 'needs_refinement', readiness);

    // Enqueue refinement task - the refiner will ask questions if needed,
    // or proceed to approval if the ticket is truly ready
    linearQueue.enqueue({
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      taskType: 'refine',
      priority: task.priority,
      readinessScore: readiness.score,
      inputData: { readiness },
    });
  }

  private async handleRefine(task: LinearQueueItem): Promise<void> {
    // Use cache-first lookup to reduce API calls
    const ticket = await linearClient.getTicketCached(task.ticketId);
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

    // Use cached comments if available
    const comments = await linearClient.getCommentsCached(task.ticketId);

    // Build dynamic codebase context from filesystem and Linear
    // This helps the refiner ask smart questions instead of asking about obvious tech choices
    const codebaseContext = await buildCodebaseContext(
      config.agents.workDir,
      linearClient,
      task.ticketId
    );

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
          isFromTaskAgent: c.user?.isMe || hasTaskAgentTag(c.body),
        })),
        codebaseContext,
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
    } else if (refinement.action === 'suggest_improvements') {
      // The refiner has suggested improvements to the description
      // Update the ticket with the improved description and proceed to approval
      if (refinement.suggestedDescription) {
        logger.info(
          { ticketId: task.ticketIdentifier },
          'Updating ticket with suggested improvements'
        );
        await linearClient.updateDescription(task.ticketId, refinement.suggestedDescription);
      }

      // Now request approval with the improved description
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
          // Filter out questions that have already been asked (check against cached comments)
          const existingCommentBodies = comments.map(c => c.body);
          const newQuestions = questionComments.filter(questionComment => {
            // Extract the core question text (first line after the tag)
            const questionLines = questionComment.split('\n').filter(l => l.trim());
            const questionText = questionLines.find(l => !l.includes('[TaskAgent]'))?.trim() || '';

            // Check if this question (or very similar) already exists in comments
            const isDuplicate = existingCommentBodies.some(existingBody => {
              // Check if the existing comment contains the same question text
              if (existingBody.includes(questionText) && questionText.length > 20) {
                return true;
              }
              // Also check for the full comment match
              if (existingBody === questionComment) {
                return true;
              }
              return false;
            });

            if (isDuplicate) {
              logger.debug(
                { ticketId: task.ticketIdentifier, questionPreview: questionText.slice(0, 50) },
                'Skipping duplicate question'
              );
            }
            return !isDuplicate;
          });

          if (newQuestions.length > 0) {
            logger.info(
              {
                ticketId: task.ticketIdentifier,
                totalQuestions: questionComments.length,
                newQuestions: newQuestions.length,
                skippedDuplicates: questionComments.length - newQuestions.length
              },
              'Posting new questions (filtered duplicates)'
            );

            // Post each NEW question as a separate comment
            for (const comment of newQuestions) {
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
          } else {
            logger.info(
              { ticketId: task.ticketIdentifier },
              'All questions were duplicates - skipping, will check for responses'
            );
            // All questions were duplicates - just wait for responses to existing questions
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
          }
        }
      }
    }
  }

  private async handleCheckResponse(task: LinearQueueItem): Promise<void> {
    // For response checking, we want fresh data since webhooks should have updated cache
    // Use cached version - webhooks keep it updated
    const comments = await linearClient.getCommentsCached(task.ticketId);
    const waitingFor = task.inputData?.waitingFor as string;

    logger.info(
      { ticketId: task.ticketIdentifier, waitingFor, commentCount: comments.length },
      'Checking for response'
    );

    if (waitingFor === 'approval') {
      // Check if we got an emoji reaction from the webhook
      const emojiReaction = task.inputData?.emojiReaction as string | undefined;

      // Try emoji reaction first, then fall back to comment-based detection
      const response = emojiReaction || this.findApprovalResponse(comments);

      logger.info(
        { ticketId: task.ticketIdentifier, response: response || 'none', viaEmoji: !!emojiReaction },
        'Approval check result'
      );

      if (response === 'approved') {
        // Clear from awaiting response since we got a response
        queueScheduler.clearAwaitingResponse(task.ticketId);
        pendingApprovalRequests.delete(task.ticketId);

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
        pendingApprovalRequests.delete(task.ticketId);

        linearQueue.complete(task.id, { response: 'rejected' });
        await this.syncLabel(task.ticketId, null); // Remove label
        this.callbacks.onStateChange?.(task.ticketId, 'new');
      } else {
        // No response yet - complete without action, scheduler will re-enqueue later
        logger.debug({ ticketId: task.ticketIdentifier }, 'No approval response yet');
        linearQueue.complete(task.id, { response: 'none' });
      }
    } else if (waitingFor === 'questions') {
      // Check if there's a human response after our questions
      // Responses can come in two forms:
      // 1. A new comment from a human after our questions
      // 2. Checked checkboxes in our question comments (Linear edits the comment in place)
      const lastAgentComment = comments
        .filter((c) => c.user?.isMe || hasTaskAgentTag(c.body))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      logger.info(
        {
          ticketId: task.ticketIdentifier,
          hasAgentComment: !!lastAgentComment,
          lastAgentCommentTime: lastAgentComment?.createdAt?.toISOString(),
        },
        'Checking for human response to questions'
      );

      if (lastAgentComment) {
        // Check for new human comments after our questions
        const humanResponses = comments.filter(
          (c) =>
            !c.user?.isMe &&
            !hasTaskAgentTag(c.body) &&
            c.createdAt > lastAgentComment.createdAt
        );

        // Also check if any question comments have checked checkboxes
        // When users check boxes in Linear, the comment is edited in place
        // Look for [X] or [x] in TaskAgent question comments
        const questionComments = comments.filter(
          (c) => hasTaskAgentTag(c.body) && (
            c.body.includes('❗') || c.body.includes('❓') || c.body.includes('💭')
          )
        );
        const hasCheckedBoxes = questionComments.some(
          (c) => c.body.includes('[X]') || c.body.includes('[x]')
        );

        const hasHumanResponse = humanResponses.length > 0 || hasCheckedBoxes;

        logger.info(
          {
            ticketId: task.ticketIdentifier,
            hasHumanResponse,
            humanResponseCount: humanResponses.length,
            hasCheckedBoxes,
            questionCommentsCount: questionComments.length,
          },
          'Human response check result'
        );

        if (hasHumanResponse) {
          // Clear from awaiting response since we got a response
          queueScheduler.clearAwaitingResponse(task.ticketId);

          logger.info({ ticketId: task.ticketIdentifier }, 'Human responded to questions, consolidating description');

          // Consolidate the Q&A into an improved description
          await this.consolidateDescription(task, comments);

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
          logger.debug({ ticketId: task.ticketIdentifier }, 'No human response yet');
          linearQueue.complete(task.id, { response: 'none' });
        }
      } else {
        // No agent comment found - this shouldn't happen but handle it gracefully
        logger.warn({ ticketId: task.ticketIdentifier }, 'No agent comment found while waiting for questions response');
        linearQueue.complete(task.id, { response: 'none', error: 'no_agent_comment' });
      }
    } else {
      // Unknown waitingFor value - complete the task to avoid getting stuck
      logger.warn({ ticketId: task.ticketIdentifier, waitingFor }, 'Unknown waitingFor value in check_response');
      linearQueue.complete(task.id, { response: 'unknown', waitingFor });
    }
  }

  private async handleGeneratePrompt(task: LinearQueueItem): Promise<void> {
    // Use cache-first lookup to reduce API calls
    const ticket = await linearClient.getTicketCached(task.ticketId);
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
    const worktree = await worktreeManager.create(ticket.identifier);

    logger.info(
      { ticketId: ticket.identifier, worktreePath: worktree.path, branchName: worktree.branch },
      'Enqueueing Claude Code execution'
    );

    const enqueuedTask = claudeQueue.enqueue({
      ticketId: task.ticketId,
      ticketIdentifier: ticket.identifier,
      priority: task.priority,
      readinessScore: task.readinessScore ?? undefined,
      prompt: result.data.prompt,
      worktreePath: worktree.path,
      branchName: worktree.branch,
      agentSessionId: session?.id,
    });

    if (enqueuedTask) {
      logger.info(
        { ticketId: ticket.identifier, taskId: enqueuedTask.id },
        'Successfully enqueued Claude Code execution'
      );
    } else {
      logger.error(
        { ticketId: ticket.identifier },
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
    const allTaskAgentLabels = [
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

    // Use efficient single-API-call method instead of 12+ separate calls
    await linearClient.syncTaskAgentLabel(ticketId, newLabel, allTaskAgentLabels);
  }

  /**
   * Consolidate Q&A from comments into an improved ticket description
   */
  private async consolidateDescription(
    task: LinearQueueItem,
    comments: Array<{ body: string; createdAt: Date; user: { isMe: boolean } | null }>
  ): Promise<void> {
    // Use cache-first lookup to reduce API calls
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      logger.warn({ ticketId: task.ticketIdentifier }, 'Could not fetch ticket for description consolidation');
      return;
    }

    // Format comments for the consolidator
    const formattedComments = comments.map((c) => ({
      body: c.body,
      isFromTaskAgent: c.user?.isMe || hasTaskAgentTag(c.body) || c.body.includes(APPROVAL_TAG),
      createdAt: c.createdAt,
    }));

    // Only proceed if we have both TaskAgent questions and human answers
    const hasQuestions = formattedComments.some((c) => c.isFromTaskAgent);
    const hasAnswers = formattedComments.some((c) => !c.isFromTaskAgent);

    logger.info(
      {
        ticketId: task.ticketIdentifier,
        hasQuestions,
        hasAnswers,
        totalComments: formattedComments.length,
        taskAgentComments: formattedComments.filter(c => c.isFromTaskAgent).length,
        humanComments: formattedComments.filter(c => !c.isFromTaskAgent).length,
      },
      'Checking if description consolidation needed'
    );

    if (!hasQuestions || !hasAnswers) {
      logger.debug({ ticketId: task.ticketIdentifier }, 'Skipping consolidation - no Q&A to consolidate');
      return;
    }

    logger.info({ ticketId: task.ticketIdentifier }, 'Starting description consolidation');

    try {
      const result = await descriptionConsolidatorAgent.execute({
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        data: {
          title: ticket.title,
          originalDescription: ticket.description || '',
          comments: formattedComments,
        },
      });

      if (result.success && result.data?.consolidatedDescription) {
        await linearClient.updateDescription(task.ticketId, result.data.consolidatedDescription);
        logger.info(
          { ticketId: task.ticketIdentifier, summary: result.data.summary },
          'Description consolidated from Q&A'
        );
      }
    } catch (error) {
      // Don't fail the task if consolidation fails - it's a nice-to-have
      logger.warn(
        { ticketId: task.ticketIdentifier, error },
        'Failed to consolidate description (non-fatal)'
      );
    }
  }

  private async requestApproval(
    task: LinearQueueItem,
    readiness: ReadinessScorerOutput
  ): Promise<void> {
    // Check in-memory tracking first (fastest, survives rate limit retries)
    if (pendingApprovalRequests.has(task.ticketId)) {
      logger.info({ ticketId: task.ticketIdentifier }, 'Approval already requested (in-memory), skipping duplicate');
      return;
    }

    // Check if we've already requested approval - use cached comments
    const comments = await linearClient.getCommentsCached(task.ticketId);
    const hasExistingApprovalRequest = comments.some(
      (c) => c.body.includes(APPROVAL_TAG) && c.user?.isMe
    );

    if (hasExistingApprovalRequest) {
      // Update in-memory tracking to match
      pendingApprovalRequests.add(task.ticketId);
      logger.info({ ticketId: task.ticketIdentifier }, 'Approval already requested (cache), skipping duplicate');
      return;
    }

    // Mark as pending before making the API call
    pendingApprovalRequests.add(task.ticketId);

    // Resolve all TaskAgent question comments (their content has been incorporated into the description)
    const questionCommentIds = comments
      .filter((c) => hasTaskAgentTag(c.body) && (
        c.body.includes('❗') || c.body.includes('❓') || c.body.includes('💭')
      ))
      .map((c) => c.id);

    if (questionCommentIds.length > 0) {
      logger.info(
        { ticketId: task.ticketIdentifier, count: questionCommentIds.length },
        'Resolving TaskAgent question comments'
      );
      await linearClient.resolveComments(questionCommentIds);
    }

    const commentBody = `${APPROVAL_TAG}

Ready to start (score: ${readiness.score}/100). React with 👍 to approve or 👎 to skip.`;

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
      if (hasTaskAgentTag(comment.body) || comment.body.includes(APPROVAL_TAG)) continue;
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
   * Questions are considered unanswered if they have checkboxes that haven't been checked
   */
  private hasUnansweredQuestions(
    comments: Array<{ body: string; createdAt: Date; user: { isMe: boolean } | null }>
  ): boolean {
    // Question comments use emoji markers: ❗ (critical), ❓ (important), 💭 (nice to have)
    // Check for TaskAgent tag in body since isMe may not be reliable for cached comments
    const questionComments = comments.filter(
      (c) => hasTaskAgentTag(c.body) && (
        c.body.includes('❗') || c.body.includes('❓') || c.body.includes('💭')
      )
    );

    if (questionComments.length === 0) {
      return false;
    }

    // Check if ANY question comment has unchecked boxes
    // A question with checkboxes is unanswered if it has [ ] but no [X] or [x]
    const hasUncheckedBoxes = questionComments.some((c) => {
      const hasCheckboxes = c.body.includes('[ ]') || c.body.includes('[X]') || c.body.includes('[x]');
      if (!hasCheckboxes) {
        // Question without checkboxes - consider it a free-form question
        // These are harder to track, so we'll be conservative and say unanswered
        return true;
      }
      // Has checkboxes - check if any are still unchecked
      const hasUnchecked = c.body.includes('[ ]');
      const hasChecked = c.body.includes('[X]') || c.body.includes('[x]');
      // Unanswered if has unchecked boxes AND no checked boxes (user hasn't started answering)
      // If user has checked at least one box, consider it in-progress/answered
      return hasUnchecked && !hasChecked;
    });

    return hasUncheckedBoxes;
  }
}

export const queueProcessor = new QueueProcessor();
