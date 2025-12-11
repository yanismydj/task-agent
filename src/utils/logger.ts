import pino from 'pino';
import { logToUI } from './terminal.js';

// Determine if we're in fancy mode (interactive terminal)
const isFancyMode = process.stdout.isTTY && process.env['NODE_ENV'] !== 'production';

// Create a custom destination that routes to our terminal UI
const uiDestination = {
  write(msg: string) {
    try {
      const parsed = JSON.parse(msg);
      const level = mapPinoLevel(parsed.level);
      const module = parsed.module || 'daemon';

      // Format message - extract the main message and key details
      let message = parsed.msg || '';

      // Append relevant context (but keep it short)
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
      // If parsing fails, just log raw
      logToUI('info', msg.trim());
    }
  }
};

function mapPinoLevel(level: number): 'info' | 'warn' | 'error' | 'success' | 'debug' {
  if (level <= 20) return 'debug';
  if (level <= 30) return 'info';
  if (level <= 40) return 'warn';
  return 'error';
}

// For fancy mode, use our custom UI destination
// For production/non-TTY, use regular pino-pretty or JSON
export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] || 'info',
    transport: !isFancyMode && process.env['NODE_ENV'] !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: {
      service: 'task-agent',
    },
  },
  isFancyMode ? uiDestination : undefined
);

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

// Export for checking mode
export const isInteractiveMode = isFancyMode;
