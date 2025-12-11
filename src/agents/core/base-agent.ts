import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../../config.js';
import { createChildLogger } from '../../utils/logger.js';
import type { Agent, AgentConfig, AgentInput, AgentOutput, ModelTier } from './types.js';
import { AgentError, AgentTimeoutError } from './errors.js';

const MODEL_MAP: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-4-5-20250514',
  advanced: 'claude-opus-4-5-20251101',
};

export abstract class BaseAgent<TInput, TOutput> implements Agent<TInput, TOutput> {
  abstract readonly config: AgentConfig;
  abstract readonly inputSchema: z.ZodSchema<TInput>;
  abstract readonly outputSchema: z.ZodSchema<TOutput>;

  protected client: Anthropic;
  protected logger: ReturnType<typeof createChildLogger>;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
    // Logger is initialized lazily since config isn't available in constructor
    this.logger = null as unknown as ReturnType<typeof createChildLogger>;
  }

  protected getLogger(): ReturnType<typeof createChildLogger> {
    if (!this.logger) {
      this.logger = createChildLogger({ module: this.config.name });
    }
    return this.logger;
  }

  protected getModel(): string {
    return MODEL_MAP[this.config.modelTier];
  }

  validateInput(input: unknown): TInput {
    return this.inputSchema.parse(input);
  }

  abstract execute(input: AgentInput<TInput>): Promise<AgentOutput<TOutput>>;

  getCacheKey?(input: AgentInput<TInput>): string;

  protected async callClaude<T>(
    systemPrompt: string,
    userMessage: string,
    outputSchema: Record<string, unknown>,
    options?: { maxTokens?: number; timeoutMs?: number }
  ): Promise<T> {
    const logger = this.getLogger();
    const model = this.getModel();
    const maxTokens = options?.maxTokens ?? 2048;
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs ?? 60000;

    logger.debug({ model, maxTokens }, 'Calling Claude API');

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await this.client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        betas: ['structured-outputs-2025-11-13'],
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        output_format: {
          type: 'json_schema',
          schema: outputSchema,
        },
      });

      clearTimeout(timeout);

      const content = response.content[0];
      if (!content || content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const result = JSON.parse(content.text) as T;
      const durationMs = Date.now() - startTime;

      logger.debug({ durationMs, model }, 'Claude API call completed');

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new AgentTimeoutError(this.config.type, 'unknown', timeoutMs);
      }

      logger.error(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        'Claude API call failed'
      );
      throw error;
    }
  }

  protected createSuccessOutput(data: TOutput, metadata?: Partial<AgentOutput<TOutput>['metadata']>): AgentOutput<TOutput> {
    return {
      success: true,
      data,
      metadata: {
        modelUsed: this.getModel(),
        durationMs: metadata?.durationMs ?? 0,
        cached: metadata?.cached ?? false,
        tokenCount: metadata?.tokenCount,
      },
    };
  }

  protected createErrorOutput(error: string | Error, metadata?: Partial<AgentOutput<TOutput>['metadata']>): AgentOutput<TOutput> {
    const errorMessage = error instanceof Error ? error.message : error;

    this.getLogger().error({ error: errorMessage }, 'Agent execution failed');

    return {
      success: false,
      error: errorMessage,
      metadata: {
        modelUsed: this.getModel(),
        durationMs: metadata?.durationMs ?? 0,
        cached: false,
      },
    };
  }

  protected wrapExecution<T>(
    fn: () => Promise<T>,
    ticketId: string
  ): Promise<T> {
    return fn().catch((error) => {
      if (error instanceof AgentError) {
        throw error;
      }
      throw new AgentError(
        error instanceof Error ? error.message : String(error),
        this.config.type,
        ticketId,
        true, // retryable by default
        error instanceof Error ? error : undefined
      );
    });
  }
}
