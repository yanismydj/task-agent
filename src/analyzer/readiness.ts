import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { localCache } from '../utils/cache.js';
import type { TicketInfo } from '../linear/types.js';

const logger = createChildLogger({ module: 'readiness-analyzer' });

// Use Haiku for fast, cheap readiness evaluation
const READINESS_MODEL = 'claude-haiku-4-5-20251001';

// Batch size for parallel evaluation
const EVAL_BATCH_SIZE = 5;

export interface ReadinessResult {
  ready: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  reasoning: string;
}

export interface ScoredTicket {
  ticket: TicketInfo;
  readiness: ReadinessResult;
  combinedScore: number;
}

const READINESS_SYSTEM_PROMPT = `You are evaluating a Linear ticket to determine if it's ready for a coding agent to work on.

Evaluate the ticket based on these criteria:
1. **Clear Acceptance Criteria**: Does the ticket clearly define what "done" looks like?
2. **Achievable Scope**: Can this be completed in a single PR? (not too large)
3. **No Blocking Questions**: Are there any unanswered questions or ambiguities?
4. **Sufficient Context**: Does it reference relevant files, patterns, or examples?
5. **No External Dependencies**: Can work start immediately without waiting on others?

Respond with a JSON object (no markdown code blocks, just raw JSON):
{
  "ready": boolean,
  "score": number (0-100, where 100 is perfectly ready),
  "issues": ["list of problems preventing readiness"],
  "suggestions": ["list of improvements that would help"],
  "reasoning": "brief explanation of your assessment"
}`;

// JSON Schema for structured outputs
const READINESS_SCHEMA = {
  type: 'object',
  properties: {
    ready: {
      type: 'boolean',
      description: 'Whether the ticket is ready for a coding agent to work on',
    },
    score: {
      type: 'integer',
      description: 'Readiness score from 0-100, where 100 is perfectly ready',
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of problems preventing readiness',
    },
    suggestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of improvements that would help',
    },
    reasoning: {
      type: 'string',
      description: 'Brief explanation of your assessment',
    },
  },
  required: ['ready', 'score', 'issues', 'suggestions', 'reasoning'],
  additionalProperties: false,
} as const;

export class ReadinessAnalyzer {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  /**
   * Get cached readiness result if available and still valid.
   * Uses local SQLite cache - no API calls!
   */
  private getCachedResult(ticket: TicketInfo): ReadinessResult | null {
    // Check if we need to re-evaluate (ticket updated since last eval)
    if (localCache.needsEvaluation(ticket.id, ticket.updatedAt)) {
      return null;
    }

    const cached = localCache.getReadiness(ticket.id);
    if (!cached) {
      return null;
    }

    logger.debug({ ticketId: ticket.identifier, score: cached.score }, 'Using cached readiness score');
    return {
      ready: cached.ready === 1,
      score: cached.score,
      issues: JSON.parse(cached.issues) as string[],
      suggestions: JSON.parse(cached.suggestions) as string[],
      reasoning: cached.reasoning,
    };
  }

  /**
   * Evaluate a single ticket (with caching)
   */
  async evaluate(ticket: TicketInfo): Promise<ReadinessResult> {
    // Check cache first (instant, no API call)
    const cached = this.getCachedResult(ticket);
    if (cached) {
      return cached;
    }

    return this.evaluateFresh(ticket);
  }

  /**
   * Evaluate a ticket without checking cache (forces fresh evaluation)
   */
  private async evaluateFresh(ticket: TicketInfo): Promise<ReadinessResult> {
    logger.info({ ticketId: ticket.identifier }, 'Evaluating ticket readiness');

    const ticketDescription = `
# ${ticket.identifier}: ${ticket.title}

**Priority**: ${this.priorityToString(ticket.priority)}
**State**: ${ticket.state.name}
**Labels**: ${ticket.labels.map((l) => l.name).join(', ') || 'none'}

## Description
${ticket.description || '(no description)'}
`.trim();

    try {
      // Use Haiku with structured outputs for fast evaluation
      const response = await this.client.beta.messages.create({
        model: READINESS_MODEL,
        max_tokens: 1024,
        betas: ['structured-outputs-2025-11-13'],
        system: READINESS_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Evaluate this ticket:\n\n${ticketDescription}`,
          },
        ],
        output_format: {
          type: 'json_schema',
          schema: READINESS_SCHEMA,
        },
      });

      const content = response.content[0];
      if (!content || content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      const result = JSON.parse(content.text) as ReadinessResult;

      // Save to local SQLite cache (instant, no API call)
      localCache.setReadiness({
        ticketId: ticket.id,
        ticketIdentifier: ticket.identifier,
        score: result.score,
        ready: result.ready,
        issues: result.issues,
        suggestions: result.suggestions,
        reasoning: result.reasoning,
        ticketUpdatedAt: ticket.updatedAt,
      });

      logger.info(
        {
          ticketId: ticket.identifier,
          ready: result.ready,
          score: result.score,
        },
        'Ticket readiness evaluated'
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ ticketId: ticket.identifier, error: errorMessage }, 'Failed to evaluate ticket readiness');

      return {
        ready: false,
        score: 0,
        issues: ['Failed to analyze ticket: ' + errorMessage],
        suggestions: [],
        reasoning: 'Analysis failed due to an error',
      };
    }
  }

  /**
   * Rank tickets by readiness and priority.
   * Uses parallel evaluation for tickets that need fresh analysis.
   */
  async rankTickets(tickets: TicketInfo[]): Promise<ScoredTicket[]> {
    if (tickets.length === 0) {
      return [];
    }

    // First pass: separate cached vs needs-evaluation (all local, instant)
    const cachedTickets: { ticket: TicketInfo; cached: ReadinessResult }[] = [];
    const needsEvalTickets: TicketInfo[] = [];

    for (const ticket of tickets) {
      const cached = this.getCachedResult(ticket);
      if (cached) {
        cachedTickets.push({ ticket, cached });
      } else {
        needsEvalTickets.push(ticket);
      }
    }

    logger.info(
      {
        total: tickets.length,
        cached: cachedTickets.length,
        needsEvaluation: needsEvalTickets.length,
      },
      'Ranking tickets by readiness'
    );

    const scoredTickets: ScoredTicket[] = [];

    // Add cached tickets immediately (no async needed)
    for (const { ticket, cached } of cachedTickets) {
      scoredTickets.push({
        ticket,
        readiness: cached,
        combinedScore: this.calculateCombinedScore(ticket, cached),
      });
    }

    // Evaluate remaining tickets in parallel batches
    for (let i = 0; i < needsEvalTickets.length; i += EVAL_BATCH_SIZE) {
      const batch = needsEvalTickets.slice(i, i + EVAL_BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (ticket) => {
          const readiness = await this.evaluateFresh(ticket);
          return {
            ticket,
            readiness,
            combinedScore: this.calculateCombinedScore(ticket, readiness),
          };
        })
      );

      scoredTickets.push(...results);
    }

    // Sort by combined score (highest first)
    scoredTickets.sort((a, b) => b.combinedScore - a.combinedScore);

    logger.info(
      {
        topTicket: scoredTickets[0]?.ticket.identifier,
        topScore: scoredTickets[0]?.combinedScore,
      },
      'Tickets ranked'
    );

    return scoredTickets;
  }

  /**
   * Quick check if a ticket is likely ready without full LLM evaluation.
   * Uses only cached data - returns null if no cache available.
   * Completely synchronous and instant!
   */
  quickReadinessCheck(ticket: TicketInfo): boolean | null {
    const cached = this.getCachedResult(ticket);
    return cached ? cached.ready : null;
  }

  private calculateCombinedScore(ticket: TicketInfo, readiness: ReadinessResult): number {
    // Priority: 1=Urgent, 2=High, 3=Medium, 4=Low, 0=No priority
    // Weight priority heavily: Urgent=80, High=60, Medium=40, Low=20, None=10
    const priorityWeights: Record<number, number> = {
      1: 80, // Urgent
      2: 60, // High
      3: 40, // Medium
      4: 20, // Low
      0: 10, // No priority
    };
    const priorityWeight = priorityWeights[ticket.priority] ?? 10;

    // Combine: 40% priority, 60% readiness
    return priorityWeight * 0.4 + readiness.score * 0.6;
  }

  private priorityToString(priority: number): string {
    const priorities = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
    return priorities[priority] || 'Unknown';
  }
}

export const readinessAnalyzer = new ReadinessAnalyzer();
