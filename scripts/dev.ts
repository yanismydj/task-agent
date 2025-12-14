#!/usr/bin/env tsx
/**
 * Development script that runs the daemon
 * Ngrok is now managed internally by the daemon during initialization
 * Usage: npm run dev
 */

import { spawn, ChildProcess } from 'node:child_process';
import { config } from 'dotenv';

config();

let daemonProcess: ChildProcess | null = null;

function log(source: string, message: string): void {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${timestamp}] [${source}] ${message}`);
}

function startDaemon(): ChildProcess {
  log('dev', 'Starting TaskAgent daemon...');

  const proc = spawn('npx', ['tsx', 'watch', 'src/index.ts'], {
    stdio: 'inherit',
    env: process.env,
  });

  proc.on('error', (err) => {
    log('daemon', `Error: ${err.message}`);
  });

  proc.on('exit', (code) => {
    log('daemon', `Exited with code ${code}`);
    cleanup();
  });

  return proc;
}

function cleanup(): void {
  log('dev', 'Shutting down...');

  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill('SIGTERM');
  }

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the daemon (ngrok is managed internally if webhooks are enabled)
daemonProcess = startDaemon();

log('dev', 'Development environment started');
