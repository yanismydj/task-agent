import { createChildLogger } from '../utils/logger.js';
import { linearQueue, type LinearQueueItem } from './linear-queue.js';
import { claudeQueue, type ClaudeQueueItem } from './claude-queue.js';
import { queueScheduler } from './scheduler.js';
import { linearClient, RateLimitError } from '../linear/client.js';
import { worktreeManager } from '../agents/worktree.js';
import { buildDualContext } from '../utils/context-builder.js';
import { config } from '../config.js';
import { sessionStorage } from '../sessions/index.js';
import { savePromptToCache, formatPromptForComment } from '../utils/prompt-cache.js';
import {
  readinessScorerAgent,
  ticketRefinerAgent,
  promptGeneratorAgent,
  codeExecutorAgent,
  descriptionConsolidatorAgent,
  plannerAgent,
  planConsolidatorAgent,
  planQuestionExtractorAgent,
} from '../agents/impl/index.js';
import type {
  AgentInput,
  ReadinessScorerInput,
  ReadinessScorerOutput,
  TicketRefinerInput,
  PromptGeneratorInput,
} from '../agents/core/index.js';
import type { DescriptionConsolidatorInput } from '../agents/impl/description-consolidator.js';
import type { PlannerInput } from '../agents/impl/planner.js';
import type { PlanConsolidatorInput } from '../agents/impl/plan-consolidator.js';
import type { PlanQuestionExtractorInput } from '../agents/impl/plan-question-extractor.js';
import type { SessionStatus } from '../sessions/storage.js';
// descriptionApprovalManager is used by webhook handler for description rewrites
// import { descriptionApprovalManager } from './description-approvals.js';

const logger = createChildLogger({ module: 'queue-processor' });

// Note: We always go through refinement now - the refiner decides if questions are needed

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
        case 'consolidate':
          await this.handleConsolidate(task);
          break;
        case 'execute':
          await this.handleExecuteDirect(task);
          break;
        case 'plan':
          await this.handlePlan(task);
          break;
        case 'consolidate_plan':
          await this.handleConsolidatePlan(task);
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
    let ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    // Use cached comments if available
    const comments = await linearClient.getCommentsCached(task.ticketId);

    // Check if we have Q&A to consolidate before evaluating
    // This ensures the description is updated with human answers before scoring
    const consolidated = await this.maybeConsolidateDescription(
      task.ticketId,
      task.ticketIdentifier,
      ticket.title,
      ticket.description || '',
      comments
    );

    // If consolidation happened, refetch the ticket with updated description
    if (consolidated) {
      ticket = await linearClient.getTicketCached(task.ticketId, 0); // Force refresh (maxAgeSeconds=0)
      if (!ticket) {
        linearQueue.fail(task.id, 'Ticket not found after consolidation');
        return;
      }
    }

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
      this.callbacks.onStateChange?.(task.ticketId, 'blocked', readiness);
      return;
    }

    // Check if this is an explicit approval via emoji reaction
    const emojiReaction = task.inputData?.emojiReaction as string | undefined;
    if (emojiReaction === 'approved') {
      // User explicitly approved - skip refinement and go straight to prompt generation
      logger.info({ ticketId: task.ticketIdentifier }, 'User approved via emoji - generating prompt');
      this.callbacks.onStateChange?.(task.ticketId, 'approved', readiness);

      linearQueue.enqueue({
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        taskType: 'generate_prompt',
        priority: task.priority,
        readinessScore: readiness.score,
        inputData: { readiness },
      });
      return;
    } else if (emojiReaction === 'rejected') {
      // User rejected - go back to refinement to ask more questions
      logger.info({ ticketId: task.ticketIdentifier }, 'User rejected via emoji - will ask more questions');
    }

    // Go through refinement - let the refiner decide if questions are needed
    // or if we should proceed directly to approval. This ensures consistent flow.
    this.callbacks.onStateChange?.(task.ticketId, 'needs_refinement', readiness);

    // Enqueue refinement task - the refiner will ask questions if needed,
    // or proceed to approval if the ticket is truly ready
    linearQueue.enqueue({
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      taskType: 'refine',
      priority: task.priority,
      readinessScore: readiness.score,
      inputData: { readiness, emojiReaction },
    });
  }

  private async handleRefine(task: LinearQueueItem): Promise<void> {
    // Use cache-first lookup to reduce API calls
    let ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    // Use cached comments if available
    const comments = await linearClient.getCommentsCached(task.ticketId);

    // SEQUENTIAL MODE: Consolidate any answered Q&A into the description BEFORE generating the next question
    // This ensures each question is asked with full context from previous answers
    const consolidated = await this.maybeConsolidateDescription(
      task.ticketId,
      task.ticketIdentifier,
      ticket.title,
      ticket.description || '',
      comments
    );

    // If consolidation happened, refetch the ticket with updated description
    if (consolidated) {
      ticket = await linearClient.getTicketCached(task.ticketId, 0); // Force refresh (maxAgeSeconds=0)
      if (!ticket) {
        linearQueue.fail(task.id, 'Ticket not found after consolidation');
        return;
      }
      logger.info(
        { ticketId: task.ticketIdentifier },
        'Description updated with previous answers before generating next question'
      );
    }

    // Get readiness data - either from inputData or calculate inline
    let readiness = task.inputData?.readiness as ReadinessScorerOutput | undefined;
    const forceAskQuestions = task.inputData?.forceAskQuestions as boolean | undefined;

    if (!readiness) {
      // Calculate readiness inline instead of deferring to evaluate task
      logger.info({ ticketId: task.ticketIdentifier }, 'Calculating readiness inline for refine task');

      const readinessInput: AgentInput<ReadinessScorerInput> = {
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

      const readinessResult = await readinessScorerAgent.execute(readinessInput);
      if (!readinessResult.success || !readinessResult.data) {
        linearQueue.fail(task.id, readinessResult.error || 'Failed to calculate readiness');
        return;
      }
      readiness = readinessResult.data;
    }

    // If forceAskQuestions is set (from "task_agent/clarify" label), override readiness to force questions
    if (forceAskQuestions) {
      logger.info({ ticketId: task.ticketIdentifier }, 'Force asking questions (triggered via task_agent/clarify label)');
      readiness = {
        ...readiness,
        ready: false,
        recommendedAction: 'refine',
        // Add a suggestion to prompt questions
        suggestions: [...readiness.suggestions, 'User requested clarification via label'],
      };
    }

    // Build dual context from repo summary and Linear tickets
    // This helps the refiner ask smart questions instead of asking about obvious tech choices
    const codebaseContext = await buildDualContext(config.agents.workDir, {
      tokenBudget: 8000,
      includeLinearTickets: true,
      linearClient,
    });

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
          isFromTaskAgent: isTaskAgentComment(c.user),
        })),
        codebaseContext,
        // Pass forceAskQuestions to agent so it knows to ask questions even if ticket looks ready
        forceAskQuestions,
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
      this.callbacks.onStateChange?.(task.ticketId, 'ready_for_approval');

      // Register that we're waiting for approval - webhook will trigger evaluation when user responds
      queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'approval');
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
      this.callbacks.onStateChange?.(task.ticketId, 'ready_for_approval');

      // Register that we're waiting for approval - webhook will trigger evaluation when user responds
      queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'approval');
    } else if (refinement.action === 'blocked') {
      this.callbacks.onStateChange?.(task.ticketId, 'blocked', { reason: refinement.blockerReason });
    } else {
      // Post questions - but first check if we've already asked questions without getting a response
      const hasUnansweredQuestions = this.hasUnansweredQuestions(comments);

      if (hasUnansweredQuestions) {
        logger.info(
          { ticketId: task.ticketIdentifier },
          'Already have unanswered questions, waiting for human response'
        );
        // Register for response checking
        queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'questions');
      } else {
        // Post questions as individual comments
        const questionComments = ticketRefinerAgent.formatQuestionsAsComments(refinement);

        if (questionComments.length > 0) {
          // Filter out questions that have already been asked (check against cached comments)
          const existingCommentBodies = comments.map(c => c.body);
          const newQuestions = questionComments.filter(questionComment => {
            // Extract the core question text (first line after the tag)
            const questionLines = questionComment.split('\n').filter(l => l.trim());
            // First non-empty line is the question text (may start with emoji)
            const questionText = questionLines[0]?.trim() || '';

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

            this.callbacks.onStateChange?.(task.ticketId, 'awaiting_response');

            // Register that we're waiting for questions - webhook will trigger evaluate when human responds
            queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'questions');
          } else {
            logger.info(
              { ticketId: task.ticketIdentifier },
              'All questions were duplicates - waiting for human response'
            );
            // All questions were duplicates - just wait for responses to existing questions
            queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'questions');
          }
        }
      }
    }
  }

  /**
   * Handle the @taskAgent rewrite command - consolidate discussion into updated description.
   * This is triggered directly by user mention, not through the auto-evaluation flow.
   */
  private async handleConsolidate(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    const comments = await linearClient.getCommentsCached(task.ticketId);

    logger.info(
      { ticketId: task.ticketIdentifier, commentCount: comments.length },
      'Consolidating discussion into description (@taskAgent rewrite)'
    );

    // Build input for consolidator
    const input: AgentInput<DescriptionConsolidatorInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        title: ticket.title,
        originalDescription: ticket.description || '',
        comments: comments.map((c) => ({
          body: c.body,
          isFromTaskAgent: isTaskAgentComment(c.user),
          createdAt: c.createdAt,
        })),
      },
    };

    const result = await descriptionConsolidatorAgent.execute(input);

    if (!result.success || !result.data) {
      linearQueue.fail(task.id, result.error || 'Consolidation failed');
      await linearClient.addComment(
        task.ticketId,
        `Failed to consolidate description: ${result.error || 'Unknown error'}`
      );
      return;
    }

    // Update the ticket description
    await linearClient.updateDescription(task.ticketId, result.data.consolidatedDescription);

    // Update title if suggested and valid
    const suggestedTitle = result.data.suggestedTitle;
    if (suggestedTitle && suggestedTitle !== ticket.title) {
      const isValidTitle = suggestedTitle.length >= 10 && /[a-zA-Z]{3,}/.test(suggestedTitle);
      if (isValidTitle) {
        await linearClient.updateTitle(task.ticketId, suggestedTitle);
        logger.info(
          { ticketId: task.ticketIdentifier, oldTitle: ticket.title, newTitle: suggestedTitle },
          'Ticket title updated'
        );
      }
    }

    // Post confirmation comment
    await linearClient.addComment(
      task.ticketId,
      `Updated the description based on our discussion.${suggestedTitle && suggestedTitle !== ticket.title ? `\n\nAlso updated title to: "${suggestedTitle}"` : ''}`
    );

    linearQueue.complete(task.id, result.data);
    logger.info({ ticketId: task.ticketIdentifier }, 'Description consolidated successfully');
  }

  /**
   * Handle the @taskAgent work command - start execution directly without approval flow.
   * This generates the prompt and immediately starts Claude Code.
   */
  private async handleExecuteDirect(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    logger.info(
      { ticketId: task.ticketIdentifier },
      'Starting direct execution (@taskAgent work)'
    );

    // Check if this is a restart scenario (from inputData set by webhook handler)
    const isRestart = task.inputData?.isRestart as boolean | undefined;
    const previousSessionTimestamp = task.inputData?.previousSessionTimestamp as string | undefined;
    const previousSessionStatus = task.inputData?.previousSessionStatus as SessionStatus | undefined;

    // Build restart context if applicable
    let restartContext: PromptGeneratorInput['restartContext'];
    if (isRestart && previousSessionTimestamp) {
      logger.info(
        { ticketId: task.ticketIdentifier, previousStatus: previousSessionStatus },
        'Building restart context for execution'
      );

      // Get all previous sessions
      const previousSessions = sessionStorage.listAll(task.ticketId, 10);
      const previousAttemptCount = previousSessions.length;

      // Get comments since the last session
      const allComments = await linearClient.getCommentsCached(task.ticketId);
      const cutoffDate = new Date(previousSessionTimestamp);

      // Filter to only new comments (after the previous session)
      // Exclude TaskAgent comments - we only want user feedback
      const newComments = allComments
        .filter(c => new Date(c.createdAt) > cutoffDate)
        .filter(c => !isTaskAgentComment(c.user))
        .map(c => ({
          body: c.body,
          createdAt: c.createdAt,
          isFromUser: true,
        }));

      logger.info(
        { ticketId: task.ticketIdentifier, newCommentCount: newComments.length, previousAttemptCount },
        'Retrieved restart context'
      );

      // Build a summary of what was attempted before
      let summary = `Previous attempt (${previousSessionStatus}):\n`;
      if (previousSessions.length > 0) {
        const lastSession = previousSessions[0];
        if (lastSession) {
          if (lastSession.errorMessage) {
            summary += `- Error: ${lastSession.errorMessage}\n`;
          }
          if (lastSession.prompt) {
            // Extract first line of previous prompt as summary
            const firstLine = lastSession.prompt.split('\n')[0];
            if (firstLine) {
              summary += `- Attempted: ${firstLine.slice(0, 200)}...\n`;
            }
          }
        }
      }

      restartContext = {
        previousAttemptCount,
        previousStatus: (previousSessionStatus || 'failed') as 'failed' | 'completed' | 'interrupted',
        newComments,
        summary,
      };
    }

    // Fetch attachments
    const attachments = await linearClient.getAttachments(task.ticketId);
    const attachmentsForPrompt = attachments.map(a => ({
      id: a.id,
      title: a.title,
      url: a.url,
    }));

    // Generate the prompt
    const promptInput: AgentInput<PromptGeneratorInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        ticket: {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || '',
          url: ticket.url,
          attachments: attachmentsForPrompt.length > 0 ? attachmentsForPrompt : undefined,
        },
        constraints: {
          branchNaming: `task-agent/${ticket.identifier.toLowerCase()}`,
        },
        restartContext, // Will be undefined if not a restart
      },
      context: { updatedAt: ticket.updatedAt },
    };

    const promptResult = await promptGeneratorAgent.execute(promptInput);

    if (!promptResult.success || !promptResult.data) {
      linearQueue.fail(task.id, promptResult.error || 'Prompt generation failed');
      await linearClient.addComment(
        task.ticketId,
        `Failed to generate execution prompt: ${promptResult.error || 'Unknown error'}`
      );
      return;
    }

    // Save prompt to cache if debug mode is enabled
    const promptPath = savePromptToCache(ticket.identifier, promptResult.data.prompt);

    // Post a comment with work started status (including prompt in debug mode)
    let workStartedComment: string;
    if (restartContext) {
      const newCommentCount = restartContext.newComments.length;
      workStartedComment = `Restarting work on this ticket (attempt #${restartContext.previousAttemptCount + 1})...\n\n${newCommentCount > 0 ? `Addressing ${newCommentCount} new comment(s) with feedback.` : 'Reviewing previous attempt to identify issues.'}`;
    } else {
      workStartedComment = 'Starting work on this ticket...';
    }

    if (config.debug.enabled && promptPath) {
      workStartedComment += `\n\n${formatPromptForComment(promptResult.data.prompt)}`;
    }
    await linearClient.addComment(task.ticketId, workStartedComment);

    // Set issue to In Progress
    await linearClient.setIssueInProgress(task.ticketId);

    // Create agent session
    const session = await linearClient.createAgentSession(task.ticketId);
    if (session) {
      agentSessions.set(task.ticketId, session.id);
      await linearClient.addAgentActivity(session.id, 'thought', {
        message: 'Starting work on this ticket...',
      });
    }

    // Create worktree and enqueue execution
    const worktree = await worktreeManager.create(ticket.identifier);

    logger.info(
      { ticketId: ticket.identifier, worktreePath: worktree.path, branchName: worktree.branch },
      'Enqueueing Claude Code execution (direct from @taskAgent work)'
    );

    const enqueuedTask = claudeQueue.enqueue({
      ticketId: task.ticketId,
      ticketIdentifier: ticket.identifier,
      priority: task.priority,
      prompt: promptResult.data.prompt,
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

    linearQueue.complete(task.id, promptResult.data);
    this.callbacks.onStateChange?.(task.ticketId, 'executing');
  }

  private async handleCheckResponse(task: LinearQueueItem): Promise<void> {
    // DEPRECATED: This handler is kept for backward compatibility with any queued tasks
    // New flow: webhooks/scheduler trigger 'evaluate' directly, which handles everything
    //
    // For any check_response tasks that are still in the queue, just trigger evaluation
    logger.info(
      { ticketId: task.ticketIdentifier },
      'check_response task (legacy) - triggering evaluation instead'
    );

    // Clear any awaiting response state
    queueScheduler.clearAwaitingResponse(task.ticketId);
    pendingApprovalRequests.delete(task.ticketId);

    // Complete this task
    linearQueue.complete(task.id, { redirectedTo: 'evaluate' });

    // Trigger evaluation - this is the source of truth for readiness
    // The evaluation will check comments, score readiness, and decide next steps
    linearQueue.enqueue({
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      taskType: 'evaluate',
      priority: task.priority,
      inputData: task.inputData ?? undefined, // Pass through any emoji reaction info
    });
  }

  private async handleGeneratePrompt(task: LinearQueueItem): Promise<void> {
    // Use cache-first lookup to reduce API calls
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    // Check if this is a restart scenario (from inputData set by webhook handler)
    const isRestart = task.inputData?.isRestart as boolean | undefined;
    const previousSessionTimestamp = task.inputData?.previousSessionTimestamp as string | undefined;
    const previousSessionStatus = task.inputData?.previousSessionStatus as SessionStatus | undefined;

    // Build restart context if applicable (same logic as handleExecuteDirect)
    let restartContext: PromptGeneratorInput['restartContext'];
    if (isRestart && previousSessionTimestamp) {
      logger.info(
        { ticketId: task.ticketIdentifier, previousStatus: previousSessionStatus },
        'Building restart context for prompt generation (approval flow)'
      );

      const previousSessions = sessionStorage.listAll(task.ticketId, 10);
      const previousAttemptCount = previousSessions.length;

      const allComments = await linearClient.getCommentsCached(task.ticketId);
      const cutoffDate = new Date(previousSessionTimestamp);

      const newComments = allComments
        .filter(c => new Date(c.createdAt) > cutoffDate)
        .filter(c => !isTaskAgentComment(c.user))
        .map(c => ({
          body: c.body,
          createdAt: c.createdAt,
          isFromUser: true,
        }));

      let summary = `Previous attempt (${previousSessionStatus}):\n`;
      if (previousSessions.length > 0) {
        const lastSession = previousSessions[0];
        if (lastSession) {
          if (lastSession.errorMessage) {
            summary += `- Error: ${lastSession.errorMessage}\n`;
          }
          if (lastSession.prompt) {
            const firstLine = lastSession.prompt.split('\n')[0];
            if (firstLine) {
              summary += `- Attempted: ${firstLine.slice(0, 200)}...\n`;
            }
          }
        }
      }

      restartContext = {
        previousAttemptCount,
        previousStatus: (previousSessionStatus || 'failed') as 'failed' | 'completed' | 'interrupted',
        newComments,
        summary,
      };

      logger.info(
        { ticketId: task.ticketIdentifier, newCommentCount: newComments.length },
        'Built restart context for approval flow'
      );
    }

    // Fetch attachments
    const attachments = await linearClient.getAttachments(task.ticketId);
    const attachmentsForPrompt = attachments.map(a => ({
      id: a.id,
      title: a.title,
      url: a.url,
    }));

    const input: AgentInput<PromptGeneratorInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        ticket: {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || '',
          url: ticket.url,
          attachments: attachmentsForPrompt.length > 0 ? attachmentsForPrompt : undefined,
        },
        constraints: {
          branchNaming: `task-agent/${ticket.identifier.toLowerCase()}`,
        },
        restartContext, // Will be undefined if not a restart
      },
      context: { updatedAt: ticket.updatedAt },
    };

    const result = await promptGeneratorAgent.execute(input);

    if (!result.success || !result.data) {
      linearQueue.fail(task.id, result.error || 'Prompt generation failed');
      this.callbacks.onStateChange?.(task.ticketId, 'failed');
      return;
    }

    linearQueue.complete(task.id, result.data);

    // Save prompt to cache if debug mode is enabled
    savePromptToCache(ticket.identifier, result.data.prompt);

    // Post a comment with work started status (including prompt in debug mode)
    let workStartedComment = 'Starting work on this ticket...';
    if (config.debug.enabled) {
      workStartedComment += `\n\n${formatPromptForComment(result.data.prompt)}`;
    }
    await linearClient.addComment(task.ticketId, workStartedComment);

    // Set issue to In Progress
    await linearClient.setIssueInProgress(task.ticketId);

    // Create agent session
    const session = await linearClient.createAgentSession(task.ticketId);
    if (session) {
      agentSessions.set(task.ticketId, session.id);
      await linearClient.addAgentActivity(session.id, 'thought', {
        message: 'Starting work on this ticket...',
      });
    }

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
    linearQueue.complete(task.id, { synced: true });
    this.callbacks.onStateChange?.(task.ticketId, state);
  }

  /**
   * Handle the @taskAgent plan command - enter planning mode with Claude Code.
   * Claude will ask clarifying questions which are posted as individual comments
   * with multiple-choice checkboxes for easy user response.
   */
  private async handlePlan(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    logger.info(
      { ticketId: task.ticketIdentifier },
      'Starting planning mode (@taskAgent plan)'
    );

    // Post acknowledgement
    await linearClient.addComment(task.ticketId, 'Entering planning mode to gather requirements...');

    // Track planning start time for file detection
    const planningStartTime = Date.now();

    // Create worktree for the planning session
    const worktree = await worktreeManager.create(ticket.identifier);

    // Build input for planner agent
    const plannerInput: AgentInput<PlannerInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: ticket.identifier,
      data: {
        ticketIdentifier: ticket.identifier,
        title: ticket.title,
        description: ticket.description || '',
        worktreePath: worktree.path,
        branchName: worktree.branch,
      },
    };

    const result = await plannerAgent.execute(plannerInput);

    // Try to attach plan file if one was created
    await this.attachPlanFileIfExists(task.ticketId, task.ticketIdentifier, planningStartTime);

    // Clean up worktree
    await worktreeManager.remove(ticket.identifier);

    if (!result.success || !result.data) {
      linearQueue.fail(task.id, result.error || 'Planning failed');
      await linearClient.addComment(
        task.ticketId,
        `Planning mode failed: ${result.error || 'Unknown error'}`
      );
      return;
    }

    // Use the question extractor agent to get structured questions with multiple-choice options
    // This replaces the old regex-based parseQuestions() approach
    const extractorInput: AgentInput<PlanQuestionExtractorInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: ticket.identifier,
      data: {
        ticketTitle: ticket.title,
        ticketDescription: ticket.description || '',
        rawPlanOutput: result.data.output,
      },
    };

    const extractorResult = await planQuestionExtractorAgent.execute(extractorInput);

    if (!extractorResult.success || !extractorResult.data) {
      // Extraction failed - fall back to posting raw output
      logger.warn(
        { ticketId: task.ticketIdentifier, error: extractorResult.error },
        'Question extraction failed, falling back to basic completion'
      );
      await linearClient.addComment(
        task.ticketId,
        `Planning analysis complete. Use \`@taskAgent work\` to start implementation.\n\n_Note: Could not extract structured questions._`
      );
      linearQueue.complete(task.id, result.data);
      return;
    }

    const { questions, planContent } = extractorResult.data;

    logger.info(
      {
        ticketId: task.ticketIdentifier,
        questionCount: questions.length,
        planContentLength: planContent.length,
      },
      'Extracted structured questions from planning output'
    );

    // Update ticket description with plan content (questions already removed by extractor)
    if (planContent && planContent.trim().length > 50) {
      const updatedDescription = `# Implementation Plan

${planContent}

---

# Original Description

${ticket.description || ''}`;

      await linearClient.updateDescription(task.ticketId, updatedDescription);
      logger.info(
        { ticketId: task.ticketIdentifier, planLength: planContent.length },
        'Updated ticket description with implementation plan'
      );
    }

    // Post questions as individual comments WITH checkboxes (matching clarify flow format)
    if (questions.length > 0) {
      logger.info(
        { ticketId: task.ticketIdentifier, questionCount: questions.length },
        'Posting planning questions as individual comments with checkboxes'
      );

      for (const q of questions) {
        // Format like the refiner does: emoji + question + options with checkboxes
        const priorityEmoji = q.priority === 'critical' ? '❗' :
                              q.priority === 'important' ? '❓' : '💭';
        const selectHint = q.allowMultiple ? '(select all that apply)' : '(select one)';

        let comment = `${priorityEmoji} ${q.question} ${selectHint}\n`;
        for (const option of q.options) {
          comment += `- [ ] ${option}\n`;
        }

        await linearClient.addComment(task.ticketId, comment.trim());
      }

      // Register that we're waiting for answers
      queueScheduler.registerAwaitingResponse(task.ticketId, task.ticketIdentifier, 'questions');

      await linearClient.addComment(
        task.ticketId,
        '✅ Planning questions posted! Please answer the questions above by checking the boxes.\n\n' +
        '**When you\'re done answering all questions**, post a comment with `/done` to consolidate the plan.\n\n' +
        'Note: Unanswered questions will be treated as skipped.'
      );

      this.callbacks.onStateChange?.(task.ticketId, 'awaiting_planning_response');
    } else {
      // No questions - planning complete
      await linearClient.addComment(
        task.ticketId,
        '✅ Planning complete! Use `@taskAgent work` to start implementation.'
      );
    }

    linearQueue.complete(task.id, extractorResult.data);
    logger.info({ ticketId: task.ticketIdentifier }, 'Planning mode completed');
  }

  /**
   * Handle consolidation of planning Q&A into a comprehensive plan.
   * This is triggered when users respond to planning questions.
   */
  private async handleConsolidatePlan(task: LinearQueueItem): Promise<void> {
    const ticket = await linearClient.getTicketCached(task.ticketId);
    if (!ticket) {
      linearQueue.fail(task.id, 'Ticket not found');
      return;
    }

    const comments = await linearClient.getCommentsCached(task.ticketId);

    logger.info(
      { ticketId: task.ticketIdentifier, commentCount: comments.length },
      'Consolidating planning Q&A into implementation plan'
    );

    // Check if there are planning questions in comments
    const hasPlanningQuestions = comments.some(
      (c) => isTaskAgentComment(c.user) && c.body.includes('Planning Question')
    );

    if (!hasPlanningQuestions) {
      logger.warn(
        { ticketId: task.ticketIdentifier },
        'No planning questions found - cannot consolidate plan'
      );
      linearQueue.fail(task.id, 'No planning questions found');
      return;
    }

    // Check if there are human responses after the planning questions
    const firstPlanningQuestion = comments.find(
      (c) => isTaskAgentComment(c.user) && c.body.includes('Planning Question')
    );

    if (!firstPlanningQuestion) {
      linearQueue.fail(task.id, 'Cannot find planning questions');
      return;
    }

    const hasHumanResponses = comments.some(
      (c) => !isTaskAgentComment(c.user) && c.createdAt > firstPlanningQuestion.createdAt
    );

    if (!hasHumanResponses) {
      logger.info(
        { ticketId: task.ticketIdentifier },
        'No human responses yet - waiting for answers to planning questions'
      );
      linearQueue.fail(task.id, 'No human responses yet');
      return;
    }

    // Build input for plan consolidator
    const input: AgentInput<PlanConsolidatorInput> = {
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      data: {
        title: ticket.title,
        originalDescription: ticket.description || '',
        comments: comments.map((c) => ({
          body: c.body,
          isFromTaskAgent: isTaskAgentComment(c.user),
          createdAt: c.createdAt,
        })),
      },
    };

    const result = await planConsolidatorAgent.execute(input);

    if (!result.success || !result.data) {
      linearQueue.fail(task.id, result.error || 'Plan consolidation failed');
      await linearClient.addComment(
        task.ticketId,
        `Failed to consolidate plan: ${result.error || 'Unknown error'}`
      );
      return;
    }

    // Analyze which questions were answered vs skipped
    const planningQuestions = comments.filter(
      (c) => isTaskAgentComment(c.user) && c.body.includes('Planning Question')
    );
    const questionsWithCheckboxes = planningQuestions.filter(
      (c) => c.body.includes('- [') // Has checkbox format
    );
    const answeredQuestions = questionsWithCheckboxes.filter(
      (c) => c.body.includes('[X]') || c.body.includes('[x]')
    );
    const unansweredQuestions = questionsWithCheckboxes.filter(
      (c) => !c.body.includes('[X]') && !c.body.includes('[x]')
    );

    logger.info(
      {
        ticketId: task.ticketIdentifier,
        totalQuestions: questionsWithCheckboxes.length,
        answeredCount: answeredQuestions.length,
        skippedCount: unansweredQuestions.length,
      },
      'Question response analysis complete'
    );

    // Update the ticket description with the consolidated plan
    // Prepend the plan to the original description
    const updatedDescription = `# Implementation Plan

${result.data.consolidatedPlan}

---

# Original Description

${ticket.description || ''}`;

    await linearClient.updateDescription(task.ticketId, updatedDescription);

    // Post confirmation comment with question statistics
    let confirmationMessage = `✅ Planning complete! I've consolidated our discussion into an implementation plan and updated the ticket description.\n\n`;

    if (questionsWithCheckboxes.length > 0) {
      confirmationMessage += `**Question Summary:**\n`;
      confirmationMessage += `- Answered: ${answeredQuestions.length}/${questionsWithCheckboxes.length}\n`;

      if (unansweredQuestions.length > 0) {
        confirmationMessage += `- Skipped: ${unansweredQuestions.length}\n\n`;
        confirmationMessage += `Note: Unanswered questions were treated as skipped and the plan proceeds without those answers.\n\n`;
      }
    }

    confirmationMessage += `You can now use \`@taskAgent work\` to start implementation.`;

    await linearClient.addComment(task.ticketId, confirmationMessage);

    // Clear awaiting response state
    queueScheduler.clearAwaitingResponse(task.ticketId);

    linearQueue.complete(task.id, result.data);
    logger.info({ ticketId: task.ticketIdentifier }, 'Plan consolidation completed');
  }

  private async handleExecution(task: ClaudeQueueItem): Promise<void> {
    if (!task.prompt || !task.worktreePath || !task.branchName) {
      claudeQueue.fail(task.id, 'Missing execution parameters');
      return;
    }

    // Create session record for persistence/resumption
    const session = sessionStorage.create({
      ticketId: task.ticketId,
      ticketIdentifier: task.ticketIdentifier,
      queueItemId: task.id,
      prompt: task.prompt,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
      agentSessionId: task.agentSessionId ?? undefined,
    });

    logger.debug(
      { ticketId: task.ticketIdentifier, sessionId: session.id },
      'Created session record for execution'
    );

    // Update agent activity
    if (task.agentSessionId) {
      await linearClient.addAgentActivity(task.agentSessionId, 'action', {
        action: 'executing',
        parameter: 'Running Claude Code agent',
      });
    }

    const result = await codeExecutorAgent.execute(
      {
        ticketId: task.ticketId,
        ticketIdentifier: task.ticketIdentifier,
        data: {
          ticketIdentifier: task.ticketIdentifier,
          prompt: task.prompt,
          worktreePath: task.worktreePath,
          branchName: task.branchName,
        },
      },
      {
        onSessionIdCaptured: (claudeSessionId) => {
          sessionStorage.updateSessionId(session.id, claudeSessionId);
          logger.info(
            { ticketId: task.ticketIdentifier, claudeSessionId },
            'Captured Claude Code session ID'
          );
        },
      }
    );

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
        // Mark session as failed (no more retries)
        sessionStorage.markFailed(session.id, error);

        if (task.agentSessionId) {
          await linearClient.errorAgentSession(task.agentSessionId, error);
          agentSessions.delete(task.ticketId);
        }
        await linearClient.addComment(
          task.ticketId,
          `Failed after ${task.retryCount + 1} attempts.\n\n**Error**: ${error}\n\nEscalating for human review.`
        );
        this.callbacks.onStateChange?.(task.ticketId, 'failed', { error });
      } else {
        // Will retry - mark session as interrupted (can be resumed)
        sessionStorage.markInterrupted(session.id, `Attempt ${task.retryCount + 1} failed: ${error}`);

        await linearClient.addComment(
          task.ticketId,
          `Attempt ${task.retryCount + 1} failed: ${error}\n\nRetrying...`
        );
      }
      return;
    }

    // Success! Mark session as completed
    sessionStorage.markCompleted(session.id);

    claudeQueue.complete(task.id, result.data.prUrl ?? undefined);

    // Validate PR URL presence before changing status to "In Review"
    const MAX_PR_CREATION_RETRIES = 2;

    if (!result.data.prUrl) {
      // No PR URL detected - check if we should retry with explicit PR creation instructions
      const currentRetryCount = task.prCreationRetryCount;

      if (currentRetryCount < MAX_PR_CREATION_RETRIES) {
        // Increment retry count
        claudeQueue.incrementPrCreationRetry(task.id);

        logger.warn(
          {
            ticketId: task.ticketIdentifier,
            retryCount: currentRetryCount + 1,
            maxRetries: MAX_PR_CREATION_RETRIES
          },
          'No PR URL detected - triggering retry with explicit PR creation instructions'
        );

        // Add comment explaining the retry
        await linearClient.addComment(
          task.ticketId,
          `Work completed but no PR was created. Retrying with explicit PR creation instructions (attempt ${currentRetryCount + 1}/${MAX_PR_CREATION_RETRIES})...`
        );

        // Get the ticket to generate a new prompt with PR emphasis
        const ticket = await linearClient.getTicketCached(task.ticketId);
        if (!ticket) {
          logger.error({ ticketId: task.ticketIdentifier }, 'Failed to fetch ticket for PR retry');
          await linearClient.addComment(
            task.ticketId,
            `Failed to retry PR creation: Could not fetch ticket details.`
          );
          return;
        }

        // Fetch attachments
        const attachments = await linearClient.getAttachments(task.ticketId);
        const attachmentsForPrompt = attachments.map(a => ({
          id: a.id,
          title: a.title,
          url: a.url,
        }));

        // Generate new prompt with EMPHATIC PR creation instructions
        const prRetryPromptInput: AgentInput<PromptGeneratorInput> = {
          ticketId: task.ticketId,
          ticketIdentifier: task.ticketIdentifier,
          data: {
            ticket: {
              identifier: ticket.identifier,
              title: ticket.title,
              description: ticket.description || '',
              url: ticket.url,
              attachments: attachmentsForPrompt.length > 0 ? attachmentsForPrompt : undefined,
            },
            constraints: {
              branchNaming: `task-agent/${ticket.identifier.toLowerCase()}`,
            },
            // Add context that this is a PR creation retry
            restartContext: {
              previousAttemptCount: currentRetryCount,
              previousStatus: 'completed',
              newComments: [],
              summary: `Previous attempt completed successfully but did not create a PR. This retry MUST create and push a PR.`,
            },
          },
          context: { updatedAt: ticket.updatedAt },
        };

        const prRetryPromptResult = await promptGeneratorAgent.execute(prRetryPromptInput);

        if (!prRetryPromptResult.success || !prRetryPromptResult.data) {
          logger.error(
            { ticketId: task.ticketIdentifier, error: prRetryPromptResult.error },
            'Failed to generate PR retry prompt'
          );
          await linearClient.addComment(
            task.ticketId,
            `Failed to generate PR retry prompt: ${prRetryPromptResult.error || 'Unknown error'}`
          );
          return;
        }

        // Modify the generated prompt to add EMPHATIC PR creation instructions at the top
        const emphasizedPrompt = `CRITICAL REQUIREMENT: You MUST create a pull request (PR) for this work.

The previous attempt completed the implementation but failed to create a PR. This is a retry specifically to ensure a PR is created.

INSTRUCTIONS:
1. Review the changes that were made
2. Commit all changes with a clear message referencing ${ticket.identifier}
3. Push the branch to the remote repository
4. CREATE A PULL REQUEST using the gh CLI or similar tool
5. Ensure the PR URL is included in your final output

DO NOT complete this task without creating a PR. The PR is MANDATORY.

---

${prRetryPromptResult.data.prompt}`;

        // Save the modified prompt
        savePromptToCache(`${ticket.identifier}-pr-retry-${currentRetryCount + 1}`, emphasizedPrompt);

        // Create new worktree
        const worktree = await worktreeManager.create(ticket.identifier);

        // Create new agent session for the retry
        const retrySession = await linearClient.createAgentSession(task.ticketId);
        if (retrySession) {
          agentSessions.set(task.ticketId, retrySession.id);
          await linearClient.addAgentActivity(retrySession.id, 'thought', {
            message: `Retrying with explicit PR creation instructions (attempt ${currentRetryCount + 1})`,
          });
        }

        // Enqueue new execution with the emphasized prompt
        const retryTask = claudeQueue.enqueue({
          ticketId: task.ticketId,
          ticketIdentifier: ticket.identifier,
          priority: task.priority,
          prompt: emphasizedPrompt,
          worktreePath: worktree.path,
          branchName: worktree.branch,
          agentSessionId: retrySession?.id,
        });

        if (retryTask) {
          logger.info(
            { ticketId: ticket.identifier, taskId: retryTask.id },
            'Successfully enqueued PR creation retry'
          );
        } else {
          logger.error(
            { ticketId: ticket.identifier },
            'Failed to enqueue PR creation retry'
          );
        }

        return; // Exit early - don't mark as complete yet
      } else {
        // Max retries exceeded
        logger.error(
          {
            ticketId: task.ticketIdentifier,
            retryCount: currentRetryCount,
            maxRetries: MAX_PR_CREATION_RETRIES
          },
          'Max PR creation retries exceeded - marking as completed without PR'
        );

        await linearClient.addComment(
          task.ticketId,
          `Work completed after ${MAX_PR_CREATION_RETRIES} attempts, but no PR was created. Please create a PR manually.\n\n⚠️ **Action Required**: Create a pull request for branch \`task-agent/${task.ticketIdentifier.toLowerCase()}\``
        );

        // Fall through to normal completion (without PR URL)
      }
    }

    // Move issue to "In Review" state (not "Done" - human needs to review the PR)
    // This only happens if we have a PR URL OR if we've exhausted retries
    await linearClient.setIssueInReview(task.ticketId);

    if (task.agentSessionId) {
      const summary = result.data.prUrl
        ? `Work completed. PR: ${result.data.prUrl}`
        : 'Work completed successfully';
      await linearClient.completeAgentSession(task.agentSessionId, summary);
      agentSessions.delete(task.ticketId);
    }

    let comment = `Work completed successfully!`;
    if (result.data.prUrl) {
      comment += `\n\n**Pull Request**: ${result.data.prUrl}`;
    }
    await linearClient.addComment(task.ticketId, comment);

    this.callbacks.onStateChange?.(task.ticketId, 'completed', { prUrl: result.data.prUrl });
  }

  // ============================================================
  // Helper Methods
  // ============================================================

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
    // Check for approval text since we use a hidden marker
    const comments = await linearClient.getCommentsCached(task.ticketId);
    const hasExistingApprovalRequest = comments.some(
      (c) => isTaskAgentComment(c.user) && c.body.includes('React with 👍 to approve')
    );

    if (hasExistingApprovalRequest) {
      // Update in-memory tracking to match
      pendingApprovalRequests.add(task.ticketId);
      logger.info({ ticketId: task.ticketIdentifier }, 'Approval already requested (cache), skipping duplicate');
      return;
    }

    // Mark as pending before making the API call
    pendingApprovalRequests.add(task.ticketId);

    // Only resolve question comments that have been answered
    // (consolidation will resolve them when incorporating into description)
    // Don't resolve unanswered questions - the user still needs to see them!

    const commentBody = `Ready to start (score: ${readiness.score}/100). React with 👍 to approve or 👎 to skip.`;

    await linearClient.addComment(task.ticketId, commentBody);
    logger.info({ ticketId: task.ticketIdentifier }, 'Approval requested');
  }

  /**
   * Check if we have Q&A that should be consolidated into the description.
   * Returns true if consolidation was performed.
   *
   * Consolidation happens when:
   * 1. There are TaskAgent questions (comments with ❗/❓/💭)
   * 2. There are human responses to those questions (checked checkboxes or reply comments)
   * 3. We haven't already consolidated (no consolidation marker in description)
   */
  private async maybeConsolidateDescription(
    ticketId: string,
    ticketIdentifier: string,
    title: string,
    description: string,
    comments: Array<{ id: string; body: string; createdAt: Date; user: { id: string; name: string; isMe: boolean } | null }>
  ): Promise<boolean> {
    // Find TaskAgent question comments (unresolved ones)
    // Resolved comments don't appear in the comments list, so any question comments
    // we see are ones that haven't been consolidated yet
    const questionComments = comments.filter(
      (c) => isTaskAgentComment(c.user) && (
        c.body.includes('❗') || c.body.includes('❓') || c.body.includes('💭')
      )
    );

    if (questionComments.length === 0) {
      // No unresolved questions - either never asked or already consolidated
      logger.debug({ ticketId: ticketIdentifier }, 'No unresolved question comments, skipping consolidation');
      return false;
    }

    // Check if questions have been answered (via checkboxes or human comments)
    const hasAnsweredQuestions = questionComments.some((c) => {
      // Check for checked boxes
      return c.body.includes('[X]') || c.body.includes('[x]');
    });

    // Also check for human reply comments (not from TaskAgent)
    const humanComments = comments.filter(
      (c) => !isTaskAgentComment(c.user)
    );

    // Only consolidate if we have answered questions OR human comments after the first question
    const firstQuestionTime = questionComments[0]?.createdAt;
    const hasHumanReplies = humanComments.some(
      (c) => firstQuestionTime && c.createdAt > firstQuestionTime
    );

    if (!hasAnsweredQuestions && !hasHumanReplies) {
      logger.debug({ ticketId: ticketIdentifier }, 'Questions not answered yet, skipping consolidation');
      return false;
    }

    logger.info(
      {
        ticketId: ticketIdentifier,
        questionCount: questionComments.length,
        hasAnsweredQuestions,
        hasHumanReplies,
      },
      'Consolidating Q&A into ticket description'
    );

    // Build input for consolidator
    const input: AgentInput<DescriptionConsolidatorInput> = {
      ticketId,
      ticketIdentifier,
      data: {
        title,
        originalDescription: description,
        comments: comments.map((c) => ({
          body: c.body,
          isFromTaskAgent: isTaskAgentComment(c.user),
          createdAt: c.createdAt,
        })),
      },
    };

    const result = await descriptionConsolidatorAgent.execute(input);

    if (!result.success || !result.data) {
      logger.warn(
        { ticketId: ticketIdentifier, error: result.error },
        'Description consolidation failed, continuing without update'
      );
      return false;
    }

    // Update the ticket description
    await linearClient.updateDescription(ticketId, result.data.consolidatedDescription);
    logger.info(
      { ticketId: ticketIdentifier, summary: result.data.summary },
      'Ticket description updated with consolidated Q&A'
    );

    // Update title if suggested AND valid
    // Reject bad titles: too short, just punctuation, or same as original
    const suggestedTitle = result.data.suggestedTitle;
    if (suggestedTitle && suggestedTitle !== title) {
      const isValidTitle = suggestedTitle.length >= 10 && /[a-zA-Z]{3,}/.test(suggestedTitle);
      if (isValidTitle) {
        await linearClient.updateTitle(ticketId, suggestedTitle);
        logger.info(
          { ticketId: ticketIdentifier, oldTitle: title, newTitle: suggestedTitle },
          'Ticket title updated'
        );
      } else {
        logger.warn(
          { ticketId: ticketIdentifier, suggestedTitle },
          'Rejected invalid suggested title'
        );
      }
    }

    // Resolve the question comments since they've been incorporated
    const questionCommentIds = questionComments.map((c) => c.id);
    if (questionCommentIds.length > 0) {
      await linearClient.resolveComments(questionCommentIds);
      logger.info(
        { ticketId: ticketIdentifier, count: questionCommentIds.length },
        'Resolved TaskAgent question comments after consolidation'
      );
    }

    return true;
  }

  private hasUnansweredQuestions(
    comments: Array<{ body: string; createdAt: Date; user: { isMe: boolean } | null }>
  ): boolean {
    // Question comments use emoji markers: ❗ (critical), ❓ (important), 💭 (nice to have)
    const questionComments = comments.filter(
      (c) => isTaskAgentComment(c.user) && (
        c.body.includes('❗') || c.body.includes('❓') || c.body.includes('💭')
      )
    );

    if (questionComments.length === 0) {
      return false;
    }

    // Find the most recent question comment timestamp
    const mostRecentQuestion = questionComments.reduce((latest, c) =>
      c.createdAt > latest.createdAt ? c : latest
    );

    // Check if there's a human comment AFTER the most recent question
    // Human comments are those not from TaskAgent
    const humanCommentAfterQuestion = comments.some((c) =>
      !isTaskAgentComment(c.user) && c.createdAt > mostRecentQuestion.createdAt
    );

    if (humanCommentAfterQuestion) {
      // Human responded after our questions - consider answered
      return false;
    }

    // No human comment after questions - check checkbox state as fallback
    const hasUncheckedBoxes = questionComments.some((c) => {
      const hasCheckboxes = c.body.includes('[ ]') || c.body.includes('[X]') || c.body.includes('[x]');
      if (!hasCheckboxes) {
        // Question without checkboxes and no human reply after - unanswered
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

  /**
   * Attempt to attach a plan file from ~/.claude/plans/ to the Linear ticket
   * This runs after planning mode completes and looks for plan files modified after planning started
   * @param ticketId - Linear ticket ID
   * @param ticketIdentifier - Ticket identifier (e.g. TAS-75)
   * @param planningStartTime - Timestamp when planning started (in ms)
   */
  private async attachPlanFileIfExists(
    ticketId: string,
    ticketIdentifier: string,
    planningStartTime: number
  ): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const os = await import('node:os');

      // Construct path to ~/.claude/plans/
      const homeDir = os.homedir();
      const plansDir = path.join(homeDir, '.claude', 'plans');

      // Check if directory exists
      try {
        await fs.access(plansDir);
      } catch {
        logger.debug({ ticketId: ticketIdentifier }, 'Plans directory does not exist, skipping attachment');
        return;
      }

      // List all files in the plans directory
      const files = await fs.readdir(plansDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      if (mdFiles.length === 0) {
        logger.debug({ ticketId: ticketIdentifier }, 'No plan files found in ~/.claude/plans/');
        return;
      }

      // Find files modified after planning started
      const recentPlanFiles: Array<{ file: string; mtime: number }> = [];
      for (const file of mdFiles) {
        const filePath = path.join(plansDir, file);
        try {
          const stats = await fs.stat(filePath);
          const mtimeMs = stats.mtimeMs;

          // Check if file was modified after planning started
          if (mtimeMs >= planningStartTime) {
            recentPlanFiles.push({ file, mtime: mtimeMs });
            logger.debug(
              { ticketId: ticketIdentifier, file, mtime: new Date(mtimeMs).toISOString() },
              'Found plan file modified after planning started'
            );
          }
        } catch (error) {
          logger.warn({ ticketId: ticketIdentifier, file, error }, 'Failed to stat plan file');
        }
      }

      if (recentPlanFiles.length === 0) {
        logger.debug({ ticketId: ticketIdentifier }, 'No plan files modified during planning session');
        return;
      }

      // Sort by modification time (most recent first) and take the first one
      recentPlanFiles.sort((a, b) => b.mtime - a.mtime);
      const planFile = recentPlanFiles[0];

      if (!planFile) {
        logger.warn({ ticketId: ticketIdentifier }, 'No plan file found after sorting');
        return;
      }

      const planFilePath = path.join(plansDir, planFile.file);
      logger.info(
        { ticketId: ticketIdentifier, planFile: planFile.file },
        'Attaching plan file to Linear ticket'
      );

      // Upload the plan file
      const attachment = await linearClient.uploadPlanFile(ticketId, planFilePath, planFile.file);

      if (attachment) {
        logger.info(
          { ticketId: ticketIdentifier, planFile: planFile.file, attachmentId: attachment.id },
          'Successfully attached plan file to ticket'
        );
      } else {
        logger.warn(
          { ticketId: ticketIdentifier, planFile: planFile.file },
          'Failed to attach plan file (non-fatal)'
        );
      }
    } catch (error) {
      // Log error but don't throw - attachment failure shouldn't break the workflow
      logger.error(
        { ticketId: ticketIdentifier, error: error instanceof Error ? error.message : String(error) },
        'Error while trying to attach plan file (non-fatal)'
      );
    }
  }
}

export const queueProcessor = new QueueProcessor();
