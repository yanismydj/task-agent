import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { logToUI } from './terminal.js';

// Determine if we're in fancy mode (interactive terminal)
const isFancyMode = process.stdout.isTTY && process.env['NODE_ENV'] !== 'production';

// Ensure logs directory exists
const LOGS_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Create log file with date - rotates daily
function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOGS_DIR, `task-agent-${date}.log`);
}

// File stream for persistent logging
let fileStream: fs.WriteStream | null = null;
let currentLogDate = '';

function getFileStream(): fs.WriteStream {
  const today = new Date().toISOString().split('T')[0]!;
  if (currentLogDate !== today || !fileStream) {
    if (fileStream) {
      fileStream.end();
    }
    currentLogDate = today;
    fileStream = fs.createWriteStream(getLogFilePath(), { flags: 'a' });
  }
  return fileStream;
}

function mapPinoLevel(level: number): 'info' | 'warn' | 'error' | 'success' | 'debug' {
  if (level <= 20) return 'debug';
  if (level <= 30) return 'info';
  if (level <= 40) return 'warn';
  return 'error';
}

// Create a custom destination that writes to file and optionally to terminal UI
const multiDestination = {
  write(msg: string) {
    // Always write to log file (JSON format for easy parsing)
    const stream = getFileStream();
    stream.write(msg);

    // Also write to terminal UI in fancy mode
    if (isFancyMode) {
      try {
        const parsed = JSON.parse(msg);
        const level = mapPinoLevel(parsed.level);
        const module = parsed.module || 'daemon';

        let message = parsed.msg || '';

        const context: string[] = [];
        if (parsed.ticketId) context.push(parsed.ticketId);
        if (parsed.count !== undefined) context.push(`count=${parsed.count}`);
        if (parsed.score !== undefined) context.push(`score=${parsed.score}`);
        if (parsed.ready !== undefined) context.push(parsed.ready ? 'ready' : 'not ready');

        if (context.length > 0) {
          message += ` (${context.join(', ')})`;
        }

        logToUI(level, message, module);
      } catch {
        logToUI('info', msg.trim());
      }
    }
  }
};

// In fancy mode: use multi-destination (file + UI)
// In non-fancy mode: use pino-pretty to stdout AND write to file
export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] || 'info',
    base: {
      service: 'task-agent',
    },
  },
  multiDestination
);

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

// Export for checking mode
export const isInteractiveMode = isFancyMode;
