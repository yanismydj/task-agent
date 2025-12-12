import { createChildLogger } from '../utils/logger.js';
import { linearQueue } from '../queue/linear-queue.js';
import { queueScheduler } from '../queue/scheduler.js';
import { config } from '../config.js';
import type { WebhookIssueData, WebhookCommentData, WebhookHandlers } from './server.js';

const logger = createChildLogger({ module: 'webhook-handler' });

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

  // Clear from awaiting response - we got a response!
  queueScheduler.clearAwaitingResponse(issueId);

  // Check if we already have a response check queued
  if (linearQueue.hasActiveTask(issueId, 'check_response')) {
    logger.debug({ issueId }, 'Already have response check queued');
    return;
  }

  // Check if recently processed
  if (linearQueue.wasRecentlyProcessed(issueId, 2)) {
    logger.debug({ issueId }, 'Recently processed, skipping');
    return;
  }

  // Enqueue immediate response check with high priority
  linearQueue.enqueue({
    ticketId: issueId,
    ticketIdentifier: `webhook-${issueId}`, // We don't have the identifier, will be fetched
    taskType: 'check_response',
    priority: 1, // Urgent - human just responded!
    inputData: {
      waitingFor: 'questions', // Assume it's a response to questions
      triggeredByWebhook: true,
    },
  });

  logger.info({ issueId }, 'Enqueued response check from webhook');
}

/**
 * Handle comment updates (edits)
 * Useful for when users edit their responses
 */
async function handleCommentUpdate(data: WebhookCommentData): Promise<void> {
  // Ignore TaskAgent comments (webhooks don't have isMe, so check for tags)
  if (data.body.includes('[TaskAgent]') || data.body.includes('[TaskAgent Proposal]') || data.body.includes('[TaskAgent Working]')) {
    return;
  }

  logger.debug({ issueId: data.issueId, commentId: data.id }, 'Comment updated');

  // For now, treat edits the same as new comments
  // Could be smarter about this in the future
  await handleCommentCreate(data);
}

/**
 * Create webhook handlers configured for TaskAgent
 */
export function createWebhookHandlers(): WebhookHandlers {
  return {
    onIssueUpdate: handleIssueUpdate,
    onCommentCreate: handleCommentCreate,
    onCommentUpdate: handleCommentUpdate,
  };
}
