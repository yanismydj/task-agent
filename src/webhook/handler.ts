import { createChildLogger } from '../utils/logger.js';
import { linearQueue } from '../queue/linear-queue.js';
import { queueScheduler } from '../queue/scheduler.js';
import { config } from '../config.js';
import { linearCache } from '../linear/cache.js';
import { descriptionApprovalManager } from '../queue/description-approvals.js';
import { linearClient } from '../linear/client.js';
import type { WebhookIssueData, WebhookCommentData, WebhookReactionData, WebhookHandlers } from './server.js';

const logger = createChildLogger({ module: 'webhook-handler' });

// Linear retries webhooks after 5 seconds, so we must respond within that time
// Using 4 seconds gives us a 1 second buffer
const WEBHOOK_TIMEOUT_MS = 4000;

// Debounce delay for checkbox changes - wait this long after the last checkbox change
// before triggering re-evaluation. This gives users time to answer all questions.
const CHECKBOX_DEBOUNCE_MS = 60 * 1000; // 60 seconds

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

// Map Linear priority (0-4) to our priority type
function mapPriority(linearPriority: number): 0 | 1 | 2 | 3 | 4 {
  if (linearPriority >= 0 && linearPriority <= 4) {
    return linearPriority as 0 | 1 | 2 | 3 | 4;
  }
  return 3; // Default to medium
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

  // Skip if issue is assigned (manual work)
  if (data.assignee) {
    logger.debug({ issueId: data.identifier }, 'Ignoring assigned issue');
    return;
  }

  // Skip if issue is completed or cancelled
  if (data.state.type === 'completed' || data.state.type === 'canceled') {
    logger.debug({ issueId: data.identifier, state: data.state.name }, 'Ignoring completed/cancelled issue');
    queueScheduler.clearAwaitingResponse(data.id);
    return;
  }

  // Check if we already have an active task for this ticket
  if (linearQueue.hasAnyActiveTask(data.id)) {
    logger.debug({ issueId: data.identifier }, 'Already have active task for this issue');
    return;
  }

  // Check if recently processed
  if (linearQueue.wasRecentlyProcessed(data.id, 5)) {
    logger.debug({ issueId: data.identifier }, 'Recently processed, skipping');
    return;
  }

  // Check for TaskAgent labels to determine if we should process
  const hasTaskAgentLabel = data.labels?.some(
    (l) => l.name === 'task-agent' || l.name.startsWith('ta:')
  );

  // For tickets with TaskAgent labels awaiting response, check if something changed
  const waitingLabel = data.labels?.find(
    (l) => l.name === 'ta:pending-approval' || l.name === 'ta:awaiting-response'
  );

  if (waitingLabel) {
    // Already waiting - the comment handler will handle responses
    logger.debug({ issueId: data.identifier, label: waitingLabel.name }, 'Issue is waiting for response');
    return;
  }

  // If no TaskAgent labels and we don't have active work, consider for evaluation
  if (!hasTaskAgentLabel) {
    logger.info({ issueId: data.identifier }, 'New/updated issue detected via webhook, enqueueing for evaluation');

    linearQueue.enqueue({
      ticketId: data.id,
      ticketIdentifier: data.identifier,
      taskType: 'evaluate',
      priority: mapPriority(data.priority),
    });
  }
}

/**
 * Handle new comments from webhook
 * This is the key handler - when a human replies, we want to act quickly
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

  // Ignore comments from TaskAgent itself
  // Note: Webhooks don't have isMe flag, so we rely on checking for TaskAgent tags
  if (data.body.includes('[TaskAgent]') || data.body.includes('[TaskAgent Proposal]') || data.body.includes('[TaskAgent Working]')) {
    logger.debug({ commentId: data.id }, 'Ignoring TaskAgent comment');
    return;
  }

  const issueId = data.issueId;

  logger.info(
    { issueId, commentLength: data.body.length },
    'Human comment detected via webhook'
  );

  // Check if we already have any active task for this ticket
  if (linearQueue.hasAnyActiveTask(issueId)) {
    logger.debug({ issueId }, 'Already have active task for this ticket');
    return;
  }

  // Check if the ticket is awaiting a response from TaskAgent
  // Only enqueue check_response if we're actually waiting for something
  const isAwaitingResponse = queueScheduler.isAwaitingResponse(issueId);

  if (isAwaitingResponse) {
    // Clear from awaiting response - we got a response!
    const waitingFor = queueScheduler.getAwaitingResponseType(issueId);
    queueScheduler.clearAwaitingResponse(issueId);

    // Enqueue immediate response check with high priority
    linearQueue.enqueue({
      ticketId: issueId,
      ticketIdentifier: `webhook-${issueId}`, // We don't have the identifier, will be fetched
      taskType: 'check_response',
      priority: 1, // Urgent - human just responded!
      inputData: {
        waitingFor: waitingFor || 'questions',
        triggeredByWebhook: true,
      },
    });

    logger.info({ issueId, waitingFor }, 'Enqueued response check from webhook');
  } else {
    // Not awaiting response - this is a new comment on a ticket
    // Enqueue for evaluation to see if the ticket needs work
    linearQueue.enqueue({
      ticketId: issueId,
      ticketIdentifier: `webhook-${issueId}`,
      taskType: 'evaluate',
      priority: 2, // High priority - human just commented
    });

    logger.info({ issueId }, 'Enqueued evaluation from webhook (new comment)');
  }
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
  const isTaskAgentComment = data.body.includes('[TaskAgent]') ||
                             data.body.includes('\\[TaskAgent\\]') ||
                             data.body.includes('[TaskAgent Proposal]') ||
                             data.body.includes('[TaskAgent Working]');

  if (isTaskAgentComment) {
    // Check if there are checked boxes (user responded via checkbox)
    const hasCheckedBoxes = data.body.includes('[X]') || data.body.includes('[x]');

    if (hasCheckedBoxes) {
      const issueId = data.issueId;

      logger.info(
        { issueId, commentId: data.id },
        'User checked checkbox in TaskAgent question - debouncing before processing'
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
      const timer = setTimeout(() => {
        checkboxDebounceTimers.delete(issueId);

        logger.info({ issueId }, 'Checkbox debounce timer fired - checking for response');

        // Check if we already have a response check queued
        if (linearQueue.hasActiveTask(issueId, 'check_response')) {
          logger.debug({ issueId }, 'Already have response check queued');
          return;
        }

        // Enqueue response check
        linearQueue.enqueue({
          ticketId: issueId,
          ticketIdentifier: `webhook-${issueId}`,
          taskType: 'check_response',
          priority: 1, // High priority for human responses
          inputData: { waitingFor: 'questions' },
        });

        logger.info({ issueId }, 'Enqueued response check from checkbox update (after debounce)');
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
          '[TaskAgent] ✅ Description has been updated based on your approval.'
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
        '[TaskAgent] ❌ Description update rejected. Keeping the original description.'
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

  // Check if we already have a response check queued
  if (linearQueue.hasActiveTask(issueId, 'check_response')) {
    logger.debug({ issueId }, 'Already have response check queued');
    return;
  }

  // Enqueue response check with the emoji reaction info
  linearQueue.enqueue({
    ticketId: issueId,
    ticketIdentifier: `webhook-${issueId}`,
    taskType: 'check_response',
    priority: 1, // High priority for human responses
    inputData: {
      waitingFor: 'approval',
      emojiReaction: isApproval ? 'approved' : 'rejected',
    },
  });

  logger.info({ issueId, emoji }, 'Enqueued response check from emoji reaction');
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
