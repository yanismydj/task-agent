#!/usr/bin/env tsx
/**
 * Test script for the Ink-based UI
 * Run with: tsx scripts/test-ui.tsx
 */

import { terminalUI, setAgentStateGetter, logToUI } from '../src/ui/index.js';

// Mock agent state
setAgentStateGetter(() => ({
  agents: [
    {
      id: 'test-1',
      ticketIdentifier: 'TAS-123',
      status: 'executing',
      startedAt: new Date(Date.now() - 30000),
      recentOutput: [
        '💬 Reading package.json to understand project structure',
        '🔧 Read → package.json',
        '💬 Installing dependencies for the new feature',
        '🔧 Bash → npm install',
      ],
    },
  ],
  available: 4,
  total: 5,
}));

// Start the UI
terminalUI.start();

// Simulate some logs
let counter = 0;
const logInterval = setInterval(() => {
  counter++;
  const levels: Array<'info' | 'warn' | 'error' | 'success' | 'debug'> = ['info', 'warn', 'error', 'success', 'debug'];
  const level = levels[counter % levels.length]!;
  const messages = [
    'Processing ticket queue',
    'Checking Linear for new tickets',
    'Rate limit status: OK',
    'Agent pool status updated',
    'Webhook received from Linear',
  ];
  const message = messages[counter % messages.length]!;

  logToUI(level, message, 'daemon');

  if (counter >= 20) {
    clearInterval(logInterval);
    setTimeout(() => {
      terminalUI.stop();
      process.exit(0);
    }, 3000);
  }
}, 1000);

// Handle Ctrl+C
process.on('SIGINT', () => {
  clearInterval(logInterval);
  terminalUI.stop();
  process.exit(0);
});
