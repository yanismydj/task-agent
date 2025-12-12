#!/usr/bin/env tsx
/**
 * Development script that runs both the daemon and ngrok tunnel
 * Usage: npm run dev
 */

import { spawn, ChildProcess } from 'node:child_process';
import { config } from 'dotenv';

config();

const WEBHOOK_PORT = process.env.WEBHOOK_PORT || '3000';
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === 'true';

let daemonProcess: ChildProcess | null = null;
let ngrokProcess: ChildProcess | null = null;

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

function startNgrok(): ChildProcess | null {
  if (!WEBHOOK_ENABLED) {
    log('dev', 'Webhooks disabled, skipping ngrok');
    return null;
  }

  log('dev', `Starting ngrok tunnel on port ${WEBHOOK_PORT}...`);

  const proc = spawn('ngrok', ['http', WEBHOOK_PORT, '--log=stdout'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    // Look for the public URL in ngrok output
    const urlMatch = text.match(/url=(https:\/\/[^\s]+\.ngrok[^\s]*)/);
    if (urlMatch) {
      log('ngrok', `Tunnel URL: ${urlMatch[1]}`);
      log('ngrok', `Webhook endpoint: ${urlMatch[1]}/webhook`);
    }
    // Also check for JSON format
    const jsonUrlMatch = text.match(/"URL":"(https:\/\/[^"]+)"/);
    if (jsonUrlMatch) {
      log('ngrok', `Tunnel URL: ${jsonUrlMatch[1]}`);
      log('ngrok', `Webhook endpoint: ${jsonUrlMatch[1]}/webhook`);
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      log('ngrok', text);
    }
  });

  proc.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log('ngrok', 'ngrok not found. Install with: brew install ngrok');
      log('ngrok', 'Then authenticate with: ngrok authtoken <your-token>');
    } else {
      log('ngrok', `Error: ${err.message}`);
    }
  });

  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log('ngrok', `Exited with code ${code}`);
    }
  });

  return proc;
}

function cleanup(): void {
  log('dev', 'Shutting down...');

  if (ngrokProcess && !ngrokProcess.killed) {
    ngrokProcess.kill('SIGTERM');
  }

  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill('SIGTERM');
  }

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start both processes
ngrokProcess = startNgrok();
daemonProcess = startDaemon();

log('dev', 'Development environment started');
if (WEBHOOK_ENABLED) {
  log('dev', 'Waiting for ngrok URL... (check above for webhook endpoint)');
}
