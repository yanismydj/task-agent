import type { AgentType } from './types.js';

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly agentType: AgentType,
    public readonly ticketId: string,
    public readonly retryable: boolean,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AgentError';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      agentType: this.agentType,
      ticketId: this.ticketId,
      retryable: this.retryable,
      cause: this.cause?.message,
    };
  }
}

export class AgentTimeoutError extends AgentError {
  public readonly timeoutMs: number;

  constructor(agentType: AgentType, ticketId: string, timeoutMs: number) {
    super(`Agent timed out after ${timeoutMs}ms`, agentType, ticketId, true);
    this.name = 'AgentTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class AgentValidationError extends AgentError {
  public readonly validationDetails: string;

  constructor(agentType: AgentType, ticketId: string, details: string) {
    super(`Input validation failed: ${details}`, agentType, ticketId, false);
    this.name = 'AgentValidationError';
    this.validationDetails = details;
  }
}

export class AgentExecutionError extends AgentError {
  constructor(
    agentType: AgentType,
    ticketId: string,
    message: string,
    retryable: boolean = true,
    cause?: Error
  ) {
    super(message, agentType, ticketId, retryable, cause);
    this.name = 'AgentExecutionError';
  }
}

export class AgentCacheError extends AgentError {
  constructor(agentType: AgentType, ticketId: string, message: string) {
    super(`Cache error: ${message}`, agentType, ticketId, true);
    this.name = 'AgentCacheError';
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof AgentError) {
    return error.retryable;
  }
  // Network errors and rate limits are typically retryable
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('rate limit') ||
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT')
    );
  }
  return false;
}
