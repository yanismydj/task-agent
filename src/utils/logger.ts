import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] || 'info',
  transport:
    process.env['NODE_ENV'] !== 'production'
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
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
