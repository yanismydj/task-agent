import { config } from './config.js';
import { logger, isInteractiveMode } from './utils/logger.js';
import { terminalUI, setAgentStateGetter } from './utils/terminal.js';
import { stateManager } from './linear/state.js';
import { linearClient } from './linear/client.js';
import { initializeAuth, getAuth } from './linear/auth.js';
import { queueManager, queueProcessor, queueScheduler } from './queue/index.js';
import { webhookServer, createWebhookHandlers } from './webhook/index.js';
import { codeExecutorAgent, plannerAgent } from './agents/impl/index.js';
import { claudeQueue } from './queue/claude-queue.js';
import { startNgrok, stopNgrok } from './utils/ngrok.js';

async function checkOAuthAuthorization(): Promise<void> {
  if (config.linear.auth.mode !== 'oauth') {
    return; // Using API key mode, no OAuth needed
  }

  initializeAuth({
    clientId: config.linear.auth.clientId,
    clientSecret: config.linear.auth.clientSecret,
  });

  const auth = getAuth();

  // Try to get a valid token - this will attempt refresh if token is expired
  try {
    await auth.getAccessToken();
    // Token is valid (either cached or refreshed)
  } catch {
    // Token invalid and refresh failed - need full re-authorization
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
      // Get running agents from both code executor and planner
      const executorAgents = codeExecutorAgent.getRunningAgents();
      const plannerAgents = plannerAgent.getRunningAgents();

      const processingCount = claudeQueue.getProcessingCount();
      const total = config.agents.maxCodeExecutors;
      const available = Math.max(0, total - processingCount);

      // Combine both agent types for display
      const allAgents = [
        ...executorAgents.map((agent) => ({
          id: agent.id,
          ticketIdentifier: agent.ticketId,
          status: 'executing',
          startedAt: agent.startedAt,
          recentOutput: agent.recentOutput,
        })),
        ...plannerAgents.map((agent) => ({
          id: `plan-${agent.id}`,
          ticketIdentifier: agent.ticketId,
          status: 'planning',
          startedAt: agent.startedAt,
          recentOutput: agent.recentOutput,
        })),
      ];

      return {
        agents: allAgents,
        available,
        total,
      };
    });

    terminalUI.start();
  }

  // Start ngrok during initialization if webhooks are enabled (unless using custom domain)
  if (config.webhook.enabled) {
    if (config.webhook.ngrokDomain) {
      // Using custom ngrok domain - user manages ngrok externally
      if (isInteractiveMode) {
        terminalUI.setInitStatus(`Using ngrok domain: ${config.webhook.ngrokDomain}`);
      }
      logger.info({ domain: config.webhook.ngrokDomain }, 'Using custom ngrok domain (managed externally)');
    } else {
      // Start ngrok automatically
      if (isInteractiveMode) {
        terminalUI.setInitStatus('Starting ngrok tunnel...');
      }
      await startNgrok(config.webhook.port);
      if (isInteractiveMode) {
        terminalUI.setInitStatus('Ngrok tunnel established');
      }
    }
  }

  if (isInteractiveMode) {
    terminalUI.setInitStatus('Initializing system...');
  }

  logger.info('TaskAgent starting...');

  // Initialize the queue system
  queueManager.initialize();
  logger.info('Task queue system initialized');

  // Initialize and register daemon in Linear
  await stateManager.registerDaemon();

  // Pre-cache workflow states, labels, and bot user ID to avoid API calls later
  await linearClient.cacheWorkflowStatesAtStartup();
  await linearClient.cacheLabelsAtStartup();
  await linearClient.getBotUserId();

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

  // Set up periodic health check every 5 minutes to recover stuck tasks
  // Tasks stuck in 'processing' for > 10 minutes are reset to 'pending'
  const healthCheckInterval = setInterval(() => {
    queueManager.resetStuckProcessingTasks(10); // 10 minute threshold
  }, 5 * 60 * 1000); // Every 5 minutes

  async function shutdown(): Promise<void> {
    logger.info('Shutting down...');
    clearInterval(heartbeatInterval);
    clearInterval(healthCheckInterval);

    // Stop ngrok tunnel (only if we started it, not if using custom domain)
    if (config.webhook.enabled && !config.webhook.ngrokDomain) {
      stopNgrok();
    }

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

  // Mark initialization as complete
  if (isInteractiveMode) {
    terminalUI.setInitStatus('complete');
  }
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
