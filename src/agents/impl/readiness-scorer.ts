import {
  BaseAgent,
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
  ReadinessScorerInputSchema,
  ReadinessScorerOutputSchema,
  type ReadinessScorerInput,
  type ReadinessScorerOutput,
  agentCache,
} from '../core/index.js';

const READINESS_SYSTEM_PROMPT = `You are evaluating a Linear ticket to determine if it's ready for a coding agent to work on.

Evaluate the ticket based on these criteria:
1. **Clear Acceptance Criteria**: Does the ticket clearly define what "done" looks like?
2. **Achievable Scope**: Can this be completed in a single PR? (not too large)
3. **No Blocking Questions**: Are there any unanswered questions or ambiguities?
4. **Sufficient Context**: Does it reference relevant files, patterns, or examples?
5. **No External Dependencies**: Can work start immediately without waiting on others?

Based on your evaluation, recommend one of these actions:
- "execute": Ready to start work immediately (score >= 70)
- "refine": Needs clarification or improvement (score 40-69)
- "block": Has external dependencies or blockers that prevent work
- "skip": Too vague or out of scope for automated work

Return your assessment as a JSON object.`;

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
    recommendedAction: {
      type: 'string',
      enum: ['execute', 'refine', 'block', 'skip'],
      description: 'Recommended next action for this ticket',
    },
  },
  required: ['ready', 'score', 'issues', 'suggestions', 'reasoning', 'recommendedAction'],
  additionalProperties: false,
} as const;

export class ReadinessScorerAgent extends BaseAgent<ReadinessScorerInput, ReadinessScorerOutput> {
  readonly config: AgentConfig = {
    type: 'readiness-scorer',
    name: 'ReadinessScorer',
    description: 'Evaluates ticket readiness for coding agents',
    modelTier: 'fast', // Uses Haiku for speed and cost efficiency
    cacheable: true,
    timeoutMs: 30000,
  };

  readonly inputSchema = ReadinessScorerInputSchema;
  readonly outputSchema = ReadinessScorerOutputSchema;

  getCacheKey(input: AgentInput<ReadinessScorerInput>): string {
    return `readiness:${input.ticketId}`;
  }

  async execute(input: AgentInput<ReadinessScorerInput>): Promise<AgentOutput<ReadinessScorerOutput>> {
    const logger = this.getLogger();
    const startTime = Date.now();

    // Check cache first
    const cacheKey = this.getCacheKey(input);
    const ticketUpdatedAt = input.context?.updatedAt as Date | undefined;

    if (ticketUpdatedAt) {
      const cached = agentCache.get<ReadinessScorerOutput>(cacheKey, ticketUpdatedAt);
      if (cached && cached.data) {
        logger.debug({ ticketId: input.ticketIdentifier }, 'Using cached readiness score');
        return cached;
      }
    }

    // Build ticket description for evaluation
    const ticketDescription = this.buildTicketDescription(input);

    try {
      const result = await this.callClaude<ReadinessScorerOutput>(
        READINESS_SYSTEM_PROMPT,
        `Evaluate this ticket:\n\n${ticketDescription}`,
        READINESS_SCHEMA,
        { maxTokens: 1024 }
      );

      // Validate and fix recommendedAction based on score if needed
      const validatedResult = this.validateResult(result);

      const output = this.createSuccessOutput(validatedResult, {
        durationMs: Date.now() - startTime,
        cached: false,
      });

      // Cache the result
      if (ticketUpdatedAt) {
        agentCache.set(
          cacheKey,
          this.config.type,
          output,
          input.ticketId,
          ticketUpdatedAt
        );
      }

      logger.info(
        {
          ticketId: input.ticketIdentifier,
          score: validatedResult.score,
          ready: validatedResult.ready,
          action: validatedResult.recommendedAction,
        },
        'Ticket readiness evaluated'
      );

      return output;
    } catch (error) {
      return this.createErrorOutput(error instanceof Error ? error : String(error), {
        durationMs: Date.now() - startTime,
      });
    }
  }

  private buildTicketDescription(input: AgentInput<ReadinessScorerInput>): string {
    const { title, description, priority, labels, state, comments } = input.data;

    let ticketText = `# ${input.ticketIdentifier}: ${title}

**Priority**: ${this.priorityToString(priority)}
**State**: ${state.name}
**Labels**: ${labels.map((l) => l.name).join(', ') || 'none'}

## Description
${description || '(no description)'}`;

    if (comments && comments.length > 0) {
      ticketText += '\n\n## Recent Comments\n';
      for (const comment of comments.slice(-5)) {
        ticketText += `- ${comment.body.slice(0, 200)}${comment.body.length > 200 ? '...' : ''}\n`;
      }
    }

    return ticketText.trim();
  }

  private validateResult(result: ReadinessScorerOutput): ReadinessScorerOutput {
    // Ensure recommendedAction is consistent with score
    let recommendedAction = result.recommendedAction;

    if (result.score >= 70 && recommendedAction === 'refine') {
      recommendedAction = 'execute';
    } else if (result.score < 40 && recommendedAction === 'execute') {
      recommendedAction = 'refine';
    }

    return {
      ...result,
      ready: result.score >= 70,
      recommendedAction,
    };
  }

  private priorityToString(priority: number): string {
    const priorities = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
    return priorities[priority] || 'Unknown';
  }
}

export const readinessScorerAgent = new ReadinessScorerAgent();
