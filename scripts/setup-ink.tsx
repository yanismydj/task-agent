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
import { App } from './setup/App.js';

// Check if we're in an interactive terminal
if (!process.stdin.isTTY) {
  console.error('Error: This setup wizard requires an interactive terminal.');
  console.error('Please run: npm run setup');
  process.exit(1);
}

const { waitUntilExit } = render(<App />);

await waitUntilExit();
