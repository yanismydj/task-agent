import { config } from './config.js';
import { logger } from './utils/logger.js';
import { poller } from './linear/poller.js';
import { scheduler } from './orchestrator/scheduler.js';
import { stateManager } from './linear/state.js';
import { initializeAuth, getAuth } from './linear/auth.js';

logger.info('TaskAgent starting...');

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

  // Initialize and register daemon in Linear
  await stateManager.registerDaemon();

  logger.info(
    {
      teamId: config.linear.teamId,
      projectId: config.linear.projectId || '(all projects)',
      maxAgents: config.agents.maxConcurrent,
      pollInterval: `${config.daemon.pollIntervalSeconds}s`,
      authMode: config.linear.auth.mode,
    },
    'Configuration loaded'
  );

  // Set up heartbeat every 60 seconds
  const heartbeatInterval = setInterval(async () => {
    await stateManager.updateHeartbeat();
  }, 60000);

  async function shutdown(): Promise<void> {
    logger.info('Shutting down TaskAgent...');
    clearInterval(heartbeatInterval);
    poller.stop();
    await scheduler.shutdown();
    await stateManager.unregisterDaemon();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  poller.setHandler(async (tickets) => {
    await scheduler.processTickets(tickets);
  });

  poller.start();

  logger.info('TaskAgent is running. Press Ctrl+C to stop.');
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

  process.exit(1);
});
