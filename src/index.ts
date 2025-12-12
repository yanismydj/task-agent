import { config } from './config.js';
import { logger, isInteractiveMode } from './utils/logger.js';
import { terminalUI, setAgentStateGetter } from './utils/terminal.js';
import { stateManager } from './linear/state.js';
import { linearClient } from './linear/client.js';
import { initializeAuth, getAuth } from './linear/auth.js';
import { queueManager, queueProcessor, queueScheduler } from './queue/index.js';
import { webhookServer, createWebhookHandlers } from './webhook/index.js';
import { codeExecutorAgent } from './agents/impl/index.js';
import { claudeQueue } from './queue/claude-queue.js';

async function checkOAuthAuthorization(): Promise<void> {
  if (config.linear.auth.mode !== 'oauth') {
    return; // Using API key mode, no OAuth needed
  }

  initializeAuth({
    clientId: config.linear.auth.clientId,
    clientSecret: config.linear.auth.clientSecret,
  });

  const auth = getAuth();

  if (!auth.hasValidToken()) {
    console.log('\n⚠️  Linear OAuth authorization required.\n');
    console.log('Starting authorization flow...\n');
    await auth.authorize();
  }
}

async function main() {
  // Check OAuth authorization first (for OAuth mode)
  await checkOAuthAuthorization();

  // Start terminal UI if in interactive mode
  if (isInteractiveMode) {
    // Set up agent state provider for the UI
    setAgentStateGetter(() => {
      const runningTickets = codeExecutorAgent.getRunningTickets();
      const processingCount = claudeQueue.getProcessingCount();
      const total = config.agents.maxCodeExecutors;
      const available = Math.max(0, total - processingCount);

      return {
        agents: runningTickets.map((ticketId, index) => ({
          id: `exec-${ticketId}-${index}`,
          ticketIdentifier: ticketId,
          status: 'executing',
          startedAt: new Date(), // We don't track exact start time, but it's running now
          recentOutput: [] as string[],
        })),
        available,
        total,
      };
    });

    terminalUI.start();
  }

  logger.info('TaskAgent starting...');

  // Initialize the queue system
  queueManager.initialize();
  logger.info('Task queue system initialized');

  // Initialize and register daemon in Linear
  await stateManager.registerDaemon();

  logger.info(
    {
      teamId: config.linear.teamId,
      projectId: config.linear.projectId || '(all)',
      maxCodeExecutors: config.agents.maxCodeExecutors,
      pollInterval: `${config.daemon.pollIntervalSeconds}s`,
      authMode: config.linear.auth.mode,
    },
    'Configuration loaded'
  );

  // Set up heartbeat every 60 seconds
  const heartbeatInterval = setInterval(async () => {
    await stateManager.updateHeartbeat();

    // Log queue stats periodically
    const stats = queueManager.getStats();
    logger.debug(
      {
        linearPending: stats.linear.pending,
        linearProcessing: stats.linear.processing,
        claudePending: stats.claude.pending,
        claudeProcessing: stats.claude.processing,
      },
      'Queue status'
    );
  }, 60000);

  async function shutdown(): Promise<void> {
    logger.info('Shutting down...');
    clearInterval(heartbeatInterval);

    // Stop webhook server
    if (config.webhook.enabled) {
      await webhookServer.stop();
    }

    // Stop queue processing
    queueScheduler.stop();
    queueProcessor.stop();
    queueManager.shutdown();

    await stateManager.unregisterDaemon();

    if (isInteractiveMode) {
      terminalUI.stop();
    }

    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Set up processor callbacks for UI updates
  queueProcessor.setCallbacks({
    onStateChange: (ticketId, newState) => {
      logger.debug({ ticketId, newState }, 'Ticket state changed');
    },
    onError: (ticketId, error) => {
      logger.error({ ticketId, error }, 'Task error');
    },
  });

  // Check rate limit status before starting
  const waitSeconds = await linearClient.checkStartupRateLimit();
  if (waitSeconds > 0) {
    logger.warn(
      { waitSeconds, waitUntil: new Date(Date.now() + waitSeconds * 1000).toLocaleTimeString() },
      'Rate limited on startup, delaying scheduler'
    );
  }

  // Start webhook server if enabled
  if (config.webhook.enabled) {
    webhookServer.setHandlers(createWebhookHandlers());
    await webhookServer.start();
    logger.info(
      { port: webhookServer.getPort() },
      'Webhook server started - use ngrok to expose: ngrok http ' + webhookServer.getPort()
    );
  }

  // Start the queue processor (processes tasks from queues)
  queueProcessor.start(1000); // Process every 1 second

  // Start the scheduler (polls Linear and enqueues work)
  // With webhooks enabled, we can poll much less frequently
  // If rate limited, delay the initial poll
  if (waitSeconds > 0) {
    logger.info({ delaySeconds: Math.min(waitSeconds, 60) }, 'Delaying scheduler start due to rate limit');
    setTimeout(() => {
      queueScheduler.start();
      logger.info('Scheduler started after rate limit delay');
    }, Math.min(waitSeconds, 60) * 1000);
  } else {
    queueScheduler.start();
  }

  logger.info({
    webhooksEnabled: config.webhook.enabled,
    webhookPort: config.webhook.enabled ? config.webhook.port : undefined,
  }, 'Daemon running with task queue system');
}

main().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  logger.error({ error: errorMessage, stack: errorStack }, 'Failed to start TaskAgent');

  // Try to report startup error to Linear
  try {
    await stateManager.reportError('daemon-startup', error instanceof Error ? error : errorMessage, {
      phase: 'startup',
    });
  } catch {
    // Ignore if we can't report - Linear might not be initialized
  }

  if (isInteractiveMode) {
    terminalUI.stop();
  }

  process.exit(1);
});
