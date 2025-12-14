import { createChildLogger } from '../utils/logger.js';
import { linearQueue } from '../queue/linear-queue.js';
import { queueScheduler } from '../queue/scheduler.js';
import { config } from '../config.js';
import { linearCache } from '../linear/cache.js';
import { descriptionApprovalManager } from '../queue/description-approvals.js';
import { linearClient } from '../linear/client.js';
import { ticketStateMachine } from '../workflow/state-machine.js';
import { parseMention, getHelpText } from '../utils/mention-parser.js';
import type { WebhookIssueData, WebhookCommentData, WebhookReactionData, WebhookHandlers } from './server.js';

const logger = createChildLogger({ module: 'webhook-handler' });

// Helper to check if a comment is from TaskAgent (using user ID)
function isCommentFromTaskAgent(userId?: string): boolean {
  if (!userId) return false;
  const botUserId = linearClient.getCachedBotUserId();
  return botUserId !== null && userId === botUserId;
}

// Linear retries webhooks after 5 seconds, so we must respond within that time
// Using 4 seconds gives us a 1 second buffer
const WEBHOOK_TIMEOUT_MS = 4000;

// Debounce delay for checkbox changes - wait this long after the last checkbox change
// before triggering re-evaluation. This gives users time to answer multiple questions.
const CHECKBOX_DEBOUNCE_MS = 5 * 1000; // 5 seconds

// Track pending checkbox debounce timers per ticket
const checkboxDebounceTimers = new Map<string, NodeJS.Timeout>();
const lastCheckboxChange = new Map<string, Date>();

/**
 * Execute a handler with a timeout to ensure we respond to Linear within 5 seconds
 * If the handler takes too long, we log a warning but don't fail the response
 */
async function withTimeout<T>(
  handler: () => Promise<T>,
  handlerName: string
): Promise<T | void> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      logger.warn(
        { handlerName, timeoutMs: WEBHOOK_TIMEOUT_MS },
        'Webhook handler exceeded timeout - Linear may retry this webhook'
      );
      resolve(); // Resolve without waiting for handler
    }, WEBHOOK_TIMEOUT_MS);

    handler()
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        logger.error({ error, handlerName }, 'Webhook handler error');
        resolve(); // Don't propagate error - we still responded to Linear
      });
  });
}

/**
 * Handle issue updates from webhook
 * This is called when an issue is modified in Linear
 */
async function handleIssueUpdate(data: WebhookIssueData): Promise<void> {
  // Only process issues from our team
  if (data.team.id !== config.linear.teamId) {
    logger.debug({ teamId: data.team.id }, 'Ignoring issue from different team');
    return;
  }

  // Cache the ticket data from webhook payload
  linearCache.upsertTicket({
    id: data.id,
    identifier: data.identifier,
    title: data.title,
    description: data.description || null,
    priority: data.priority,
    state: data.state,
    assignee: data.assignee || null,
    labels: data.labels || [],
    createdAt: new Date(data.updatedAt), // Webhook doesn't always have createdAt
    updatedAt: new Date(data.updatedAt),
    url: '',
  });

  // Check for manual unblocking: if ticket was internally blocked but ta:blocked label was removed
  const internalState = ticketStateMachine.getState(data.id);
  const wasBlocked = internalState?.currentState === 'blocked';
  const hasBlockedLabel = data.labels?.some((l) => l.name === 'ta:blocked');

  if (wasBlocked && !hasBlockedLabel) {
    logger.info(
      { issueId: data.identifier },
      'Blocked ticket label removed - unblocking and re-evaluating'
    );
    ticketStateMachine.transition(data.id, 'new', 'Manually unblocked via label removal');
    linearQueue.enqueue({
      ticketId: data.id,
      ticketIdentifier: data.identifier,
      taskType: 'evaluate',
      priority: 2, // High priority - user took action
    });
    return;
  }

  // Clear awaiting response state for completed/cancelled issues
  if (data.state.type === 'completed' || data.state.type === 'canceled') {
    logger.debug({ issueId: data.identifier, state: data.state.name }, 'Issue completed/cancelled - clearing awaiting state');
    queueScheduler.clearAwaitingResponse(data.id);
    return;
  }

  // MENTION-TRIGGERED MODE: Do NOT auto-evaluate issues
  // Users must use @taskAgent commands in comments to trigger actions
  // This handler only caches ticket data and handles unblocking
  logger.debug({ issueId: data.identifier }, 'Issue updated - cached (mention-triggered mode, no auto-evaluation)');
}

/**
 * Handle new comments from webhook
 * Only responds to @taskAgent mentions with specific commands
 */
async function handleCommentCreate(data: WebhookCommentData): Promise<void> {
  // Cache the comment data from webhook payload
  linearCache.upsertComment(data.issueId, {
    id: data.id,
    body: data.body,
    user: data.user ? {
      id: data.user.id,
      name: data.user.name,
      isBot: false, // Webhooks don't indicate bot status
    } : undefined,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
  });

  // Ignore comments from TaskAgent itself (check user ID)
  if (isCommentFromTaskAgent(data.user?.id)) {
    logger.debug({ commentId: data.id }, 'Ignoring TaskAgent comment');
    return;
  }

  const issueId = data.issueId;

  // Parse for @taskAgent mention
  const mention = parseMention(data.body);

  if (!mention.found) {
    logger.debug({ issueId, commentLength: data.body.length }, 'No @taskAgent mention, ignoring comment');
    return;
  }

  logger.info(
    { issueId, command: mention.command, rawText: mention.rawText },
    'Detected @taskAgent mention'
  );

  // Look up the ticket identifier from cache (it has the TAS-XX format)
  const cachedTicket = linearCache.getTicket(issueId);
  const ticketIdentifier = cachedTicket?.identifier || `ticket-${issueId}`;

  // Handle help command (empty mention or unknown command)
  if (mention.command === 'help') {
    logger.info({ issueId, ticketIdentifier }, 'Responding with help text');
    await linearClient.addComment(issueId, getHelpText());
    return;
  }

  // Map mention commands to task types
  const taskTypeMap = {
    'clarify': 'refine',       // Uses TicketRefinerAgent
    'rewrite': 'consolidate',  // Uses DescriptionConsolidatorAgent
    'work': 'execute',         // Uses CodeExecutorAgent
  } as const;

  type CommandKey = keyof typeof taskTypeMap;
  const taskType = taskTypeMap[mention.command as CommandKey];
  if (!taskType) {
    logger.warn({ issueId, command: mention.command }, 'Unknown command - this should not happen');
    return;
  }

  // Clear any awaiting response state
  queueScheduler.clearAwaitingResponse(issueId);

  // Enqueue the task
  linearQueue.enqueue({
    ticketId: issueId,
    ticketIdentifier,
    taskType,
    priority: 1, // User-triggered = highest priority
  });

  logger.info({ issueId, ticketIdentifier, command: mention.command, taskType }, 'Enqueued task from @taskAgent mention');
}

/**
 * Handle comment updates (edits)
 * Useful for when users edit their responses or check checkboxes in TaskAgent questions
 */
async function handleCommentUpdate(data: WebhookCommentData): Promise<void> {
  // Always update the cache with the new comment body (important for checkbox changes)
  linearCache.upsertComment(data.issueId, {
    id: data.id,
    body: data.body,
    user: data.user ? {
      id: data.user.id,
      name: data.user.name,
      isBot: false, // Webhooks don't indicate bot status
    } : undefined,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
  });

  // Check if this is a TaskAgent question comment with checked boxes
  // When users check checkboxes, the comment body is updated with [X] or [x]
  if (isCommentFromTaskAgent(data.user?.id)) {
    // Check if there are checked boxes (user responded via checkbox)
    const hasCheckedBoxes = data.body.includes('[X]') || data.body.includes('[x]');

    if (hasCheckedBoxes) {
      const issueId = data.issueId;

      logger.info(
        { issueId, commentId: data.id },
        'User checked checkbox in TaskAgent question - debouncing before re-evaluation'
      );

      // Record this checkbox change
      lastCheckboxChange.set(issueId, new Date());

      // Clear any existing debounce timer for this ticket
      const existingTimer = checkboxDebounceTimers.get(issueId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        logger.debug({ issueId }, 'Cleared existing checkbox debounce timer');
      }

      // Set a new debounce timer - only trigger after user stops checking boxes
      // This gives users time to answer multiple questions before we re-evaluate
      const timer = setTimeout(() => {
        checkboxDebounceTimers.delete(issueId);

        logger.info({ issueId }, 'Checkbox debounce timer fired - triggering re-evaluation');

        // Clear awaiting response state
        queueScheduler.clearAwaitingResponse(issueId);

        // Log if there's already an active task, but STILL enqueue
        // The queue's enqueue() method handles deduplication - it won't create duplicates
        // We must not silently skip here as that causes tickets to get stuck
        if (linearQueue.hasAnyActiveTask(issueId)) {
          logger.info({ issueId }, 'Active task exists, but enqueueing anyway (queue will dedupe)');
        }

        // Enqueue refine task - continue the clarification flow with the new answers
        // Look up the ticket identifier from cache (it has the TAS-XX format)
        const cachedTicket = linearCache.getTicket(issueId);
        const ticketIdentifier = cachedTicket?.identifier || `ticket-${issueId}`;

        linearQueue.enqueue({
          ticketId: issueId,
          ticketIdentifier,
          taskType: 'refine',  // Continue clarification with checkbox answers
          priority: 1, // Highest priority - human just provided answers!
        });

        logger.info({ issueId, ticketIdentifier }, 'Enqueued refine from checkbox update (after debounce)');
      }, CHECKBOX_DEBOUNCE_MS);

      checkboxDebounceTimers.set(issueId, timer);
      logger.debug({ issueId, debounceMs: CHECKBOX_DEBOUNCE_MS }, 'Set checkbox debounce timer');

      return;
    }

    // TaskAgent comment without checked boxes - ignore
    logger.debug({ issueId: data.issueId, commentId: data.id }, 'TaskAgent comment updated (no checkbox change)');
    return;
  }

  logger.debug({ issueId: data.issueId, commentId: data.id }, 'Comment updated');

  // For non-TaskAgent comments, treat edits the same as new comments
  await handleCommentCreate(data);
}

/**
 * Handle emoji reactions on comments
 * When a user reacts with 👍 or 👎 to a TaskAgent Proposal comment, treat it as approval/rejection
 * Also handles description approval requests
 */
async function handleReactionCreate(data: WebhookReactionData): Promise<void> {
  // We only care about reactions on comments (approval proposals), not on issues
  if (!data.commentId) {
    logger.debug({ reactionId: data.id, emoji: data.emoji }, 'Ignoring reaction on issue (not a comment)');
    return;
  }

  // Check if this is a thumbs up/down reaction
  const emoji = data.emoji;
  const isApproval = emoji === '👍' || emoji === '+1' || emoji === 'thumbsup';
  const isRejection = emoji === '👎' || emoji === '-1' || emoji === 'thumbsdown';

  if (!isApproval && !isRejection) {
    logger.debug({ emoji }, 'Ignoring non-approval emoji reaction');
    return;
  }

  const commentId = data.commentId;

  logger.info(
    {
      commentId,
      emoji,
      userId: data.userId,
      isApproval,
    },
    'Received approval emoji reaction'
  );

  // First, check if this comment has a pending description approval
  const descriptionApproval = descriptionApprovalManager.getPendingByCommentId(commentId);
  if (descriptionApproval) {
    logger.info(
      { ticketId: descriptionApproval.ticketIdentifier, commentId, emoji },
      'Processing description approval reaction'
    );

    if (isApproval) {
      // Approve and update description
      const approved = descriptionApprovalManager.approve(commentId);
      if (!approved) {
        logger.warn({ commentId }, 'Failed to approve (already processed?)');
        return;
      }

      // Update the ticket description
      try {
        await linearClient.updateDescription(descriptionApproval.ticketId, descriptionApproval.proposedDescription);
        logger.info(
          { ticketId: descriptionApproval.ticketIdentifier },
          'Description updated after approval'
        );

        // Add a confirmation comment
        await linearClient.addComment(
          descriptionApproval.ticketId,
          '✅ Description has been updated based on your approval.'
        );

        // Clear the awaiting-description-approval label
        await linearClient.removeLabel(descriptionApproval.ticketId, 'ta:awaiting-description-approval');

      } catch (error) {
        logger.error(
          { ticketId: descriptionApproval.ticketIdentifier, error },
          'Failed to update description after approval'
        );
        // Revert approval status
        descriptionApprovalManager.reject(commentId);
      }
    } else if (isRejection) {
      // Reject - keep original description
      const rejected = descriptionApprovalManager.reject(commentId);
      if (!rejected) {
        logger.warn({ commentId }, 'Failed to reject (already processed?)');
        return;
      }

      logger.info(
        { ticketId: descriptionApproval.ticketIdentifier },
        'Description update rejected by user'
      );

      // Add a confirmation comment
      await linearClient.addComment(
        descriptionApproval.ticketId,
        '❌ Description update rejected. Keeping the original description.'
      );

      // Clear the awaiting-description-approval label
      await linearClient.removeLabel(descriptionApproval.ticketId, 'ta:awaiting-description-approval');
    }
    return;
  }

  // No description approval pending - handle as general approval reaction
  // We need issueId for this
  if (!data.issueId) {
    logger.warn({ commentId }, 'Reaction webhook missing issueId - cannot process');
    return;
  }

  const issueId = data.issueId;

  // Clear awaiting response state
  queueScheduler.clearAwaitingResponse(issueId);

  // Log if there's already an active task, but STILL enqueue
  // The queue handles deduplication - silently skipping causes tickets to get stuck
  if (linearQueue.hasAnyActiveTask(issueId)) {
    logger.info({ issueId }, 'Active task exists for reaction, but enqueueing anyway (queue will dedupe)');
  }

  // Re-evaluate - the evaluation will see the approval state and proceed accordingly
  // Pass the emoji reaction info so we can handle approval vs rejection
  // Look up the ticket identifier from cache (it has the TAS-XX format)
  const cachedTicket = linearCache.getTicket(issueId);
  const ticketIdentifier = cachedTicket?.identifier || `ticket-${issueId}`;

  linearQueue.enqueue({
    ticketId: issueId,
    ticketIdentifier,
    taskType: 'evaluate',
    priority: 1, // Highest priority - human just approved/rejected!
    inputData: {
      emojiReaction: isApproval ? 'approved' : 'rejected',
    },
  });

  logger.info({ issueId, ticketIdentifier, emoji, action: isApproval ? 'approved' : 'rejected' }, 'Enqueued evaluation from emoji reaction');
}

/**
 * Create webhook handlers configured for TaskAgent
 * Each handler is wrapped with a timeout to ensure we respond to Linear within 5 seconds
 */
export function createWebhookHandlers(): WebhookHandlers {
  return {
    onIssueUpdate: (data) => withTimeout(() => handleIssueUpdate(data), 'handleIssueUpdate'),
    onCommentCreate: (data) => withTimeout(() => handleCommentCreate(data), 'handleCommentCreate'),
    onCommentUpdate: (data) => withTimeout(() => handleCommentUpdate(data), 'handleCommentUpdate'),
    onReactionCreate: (data) => withTimeout(() => handleReactionCreate(data), 'handleReactionCreate'),
  };
}
