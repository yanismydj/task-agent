#!/usr/bin/env npx tsx
/**
 * TaskAgent Interactive Setup Wizard (Ink-based)
 *
 * A modern CLI wizard for configuring TaskAgent.
 *
 * Usage: npm run setup
 */

import React from 'react';
import { render } from 'ink';
import { execSync } from 'node:child_process';
import { App } from './setup/App.js';

// Check if we're in an interactive terminal
if (!process.stdin.isTTY) {
  console.error('Error: This setup wizard requires an interactive terminal.');
  console.error('Please run: npm run setup');
  process.exit(1);
}

// Enter alternate screen buffer (fullscreen mode)
const enterAltScreen = '\x1b[?1049h';
const leaveAltScreen = '\x1b[?1049l';
const clearScreen = '\x1b[2J\x1b[H';

process.stdout.write(enterAltScreen + clearScreen);

// Kill any ngrok processes started by setup
const killNgrok = () => {
  try {
    // Kill ngrok processes listening on port 4847 (our webhook port)
    execSync('pkill -f "ngrok http 4847"', { stdio: 'ignore' });
  } catch {
    // Ignore errors - ngrok might not be running
  }
};

// Ensure we restore the terminal and clean up on exit
const cleanup = () => {
  process.stdout.write(leaveAltScreen);
  killNgrok();
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

const { waitUntilExit } = render(<App />);

await waitUntilExit();
cleanup();
process.exit(0);
