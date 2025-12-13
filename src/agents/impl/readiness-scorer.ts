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

SCORING GUIDELINES - Be generous! Most tickets with clear intent should score 70+:
- 80-100: Clear task with good context, ready to execute immediately
- 70-79: Task is clear enough to start, minor details can be figured out
- 50-69: Needs some clarification but has a clear goal
- 30-49: Too vague or missing important information - NEEDS REFINEMENT
- 0-29: Very unclear - STILL NEEDS REFINEMENT (not blocked)

Evaluate based on:
1. **Clear Goal**: Is it clear what needs to be done? (Most important)
2. **Achievable Scope**: Can this be completed in a single PR?
3. **No Hard Blockers**: Are there external dependencies blocking work?

IMPORTANT - Be lenient on these:
- Missing file references are OK - the agent can find them
- Sparse descriptions are OK if the title makes the task clear
- Not every detail needs to be specified upfront

CRITICAL: When reading comments, look for answers to previously asked questions:
- Checkbox-style answers like "- [x] Option A" or "[x] Option A" (checked)
- Direct text responses to questions
- Multiple-choice selections

If a user has answered TaskAgent's questions, those answers ARE the acceptance criteria. A ticket with answered questions should score at least 70 unless there are hard blockers.

Recommend one of these actions:
- "execute": Ready to start work (score >= 70) - USE THIS if the task is reasonably clear
- "refine": Needs clarification (score < 70) - USE THIS for vague or unclear tickets
- "block": TRUE EXTERNAL BLOCKERS ONLY (e.g., "waiting for API credentials", "needs design review first", "depends on PR #123"). DO NOT use block for vague tickets - use refine instead!
- "skip": Completely out of scope (not a coding task)

IMPORTANT: Most tickets that aren't ready should use "refine", NOT "block". Block is ONLY for external dependencies that prevent ANY work, not for unclear requirements.

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
      // Show last 5 comments, but include full content for recent answers (up to 1000 chars each)
      // This is important for capturing checkbox responses and detailed answers
      for (const comment of comments.slice(-5)) {
        const maxLen = 1000;
        ticketText += `\n### Comment:\n${comment.body.slice(0, maxLen)}${comment.body.length > maxLen ? '\n... (truncated)' : ''}\n`;
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

    // Override "block" to "refine" unless there are true external blockers
    // True blockers are things like: waiting for credentials, depends on another PR, needs design approval
    if (recommendedAction === 'block') {
      const hasExternalBlocker = this.hasExternalBlocker(result);
      if (!hasExternalBlocker) {
        recommendedAction = 'refine';
      }
    }

    return {
      ...result,
      ready: result.score >= 70,
      recommendedAction,
    };
  }

  /**
   * Check if the issues or reasoning mention true external blockers
   * (not just vague requirements)
   */
  private hasExternalBlocker(result: ReadinessScorerOutput): boolean {
    const blockerKeywords = [
      'credentials',
      'api key',
      'api-key',
      'secret',
      'access token',
      'depends on pr',
      'depends on #',
      'waiting for',
      'blocked by',
      'needs approval',
      'design review',
      'design approval',
      'external service',
      'third party',
      'not deployed',
      'infrastructure',
    ];

    const textToCheck = [
      result.reasoning.toLowerCase(),
      ...result.issues.map((i) => i.toLowerCase()),
    ].join(' ');

    return blockerKeywords.some((keyword) => textToCheck.includes(keyword));
  }

  private priorityToString(priority: number): string {
    const priorities = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
    return priorities[priority] || 'Unknown';
  }
}

export const readinessScorerAgent = new ReadinessScorerAgent();
