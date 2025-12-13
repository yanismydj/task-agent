import {
  BaseAgent,
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
  TicketRefinerInputSchema,
  TicketRefinerOutputSchema,
  type TicketRefinerInput,
  type TicketRefinerOutput,
} from '../core/index.js';

// Minimum readiness score required to mark a ticket as "ready" for approval
// Below this threshold, we MUST ask clarifying questions
const READY_THRESHOLD = 70;

const REFINER_SYSTEM_PROMPT = `You are a technical project manager helping prepare tickets for coding agents.

Your goal is to ask clarifying questions that will help a coding agent successfully implement the ticket.

**IMPORTANT: Format questions as multiple choice with checkbox options whenever possible.**
This makes it easy for users to quickly respond by checking boxes rather than typing long answers.

Good question format (multiple choice):
- "Which error handling approach should be used?"
  Options: ["Return null on failure", "Throw exception", "Return Result type", "Log and continue"]

Bad question format (open-ended):
- "How should errors be handled?" (too vague, requires typing)

Focus areas:
1. **Scope**: What's in/out of scope? (provide options)
2. **Approach**: Which pattern or library to use? (provide options)
3. **Edge Cases**: Which scenarios to handle? (provide checklist)
4. **Testing**: What test coverage is needed? (provide options)

Guidelines:
- Provide 2-5 options per question when possible
- Options should be mutually exclusive OR allow multiple selection
- Keep questions short and specific
- Only ask open-ended questions when options aren't feasible
- Prioritize: 'critical' (blocking), 'important' (should clarify), 'nice_to_have'

**CRITICAL SCORE RULE**: If the readiness score is below 70, you MUST ask clarifying questions.
Only recommend action 'ready' if:
1. The readiness score is 70 or above, AND
2. The ticket is truly well-specified with clear acceptance criteria

If there are external blockers (dependencies, access needed, etc.), recommend action 'blocked'.`;

const REFINER_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['ask_questions', 'suggest_improvements', 'ready', 'blocked'],
      description: 'The recommended action for this ticket',
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The clarifying question to ask (keep short)',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Multiple choice options (2-5 items). Empty array for open-ended questions.',
          },
          allowMultiple: {
            type: 'boolean',
            description: 'If true, user can select multiple options. If false, single choice only.',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'important', 'nice_to_have'],
            description: 'How important is this question',
          },
        },
        required: ['question', 'options', 'allowMultiple', 'priority'],
        additionalProperties: false,
      },
      description: 'List of clarifying questions to ask',
    },
    suggestedDescription: {
      type: 'string',
      description: 'An improved version of the ticket description (optional)',
    },
    suggestedAcceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'Suggested acceptance criteria to add to the ticket',
    },
    blockerReason: {
      type: 'string',
      description: 'If blocked, explain why work cannot proceed',
    },
  },
  required: ['action', 'questions', 'suggestedAcceptanceCriteria'],
  additionalProperties: false,
} as const;

export class TicketRefinerAgent extends BaseAgent<TicketRefinerInput, TicketRefinerOutput> {
  readonly config: AgentConfig = {
    type: 'ticket-refiner',
    name: 'TicketRefiner',
    description: 'Asks clarifying questions and refines tickets for coding agents',
    modelTier: 'standard', // Uses Sonnet for better reasoning
    cacheable: false, // Always evaluate fresh based on new comments
    timeoutMs: 60000,
  };

  readonly inputSchema = TicketRefinerInputSchema;
  readonly outputSchema = TicketRefinerOutputSchema;

  async execute(input: AgentInput<TicketRefinerInput>): Promise<AgentOutput<TicketRefinerOutput>> {
    const logger = this.getLogger();
    const startTime = Date.now();

    // Build context for the refiner
    const context = this.buildContext(input);

    try {
      const result = await this.callClaude<TicketRefinerOutput>(
        REFINER_SYSTEM_PROMPT,
        context,
        REFINER_SCHEMA,
        { maxTokens: 2048 }
      );

      // Filter out questions that have already been answered
      const filteredResult = this.filterAnsweredQuestions(result, input.data.existingComments);

      // Check if readiness score is below threshold
      const readinessScore = input.data.readinessResult.score;
      if (readinessScore < READY_THRESHOLD && filteredResult.action === 'ready') {
        // Refiner says ready but score is low - only override if we have actual questions to ask
        // If refiner has no questions, trust its judgment and proceed to approval
        // (The human can reject if they disagree)
        if (filteredResult.questions.length > 0) {
          logger.info(
            {
              ticketId: input.ticketIdentifier,
              score: readinessScore,
              threshold: READY_THRESHOLD,
              questionCount: filteredResult.questions.length,
            },
            'Overriding ready→ask_questions due to low readiness score (has questions to ask)'
          );
          filteredResult.action = 'ask_questions';
        } else {
          // No questions to ask - proceed to approval despite low score
          // The refiner couldn't identify any gaps, so let human decide
          logger.info(
            {
              ticketId: input.ticketIdentifier,
              score: readinessScore,
              threshold: READY_THRESHOLD,
            },
            'Low readiness score but refiner found no questions - proceeding to approval'
          );
        }
      }

      logger.info(
        {
          ticketId: input.ticketIdentifier,
          action: filteredResult.action,
          questionCount: filteredResult.questions.length,
          criticalQuestions: filteredResult.questions.filter((q) => q.priority === 'critical').length,
        },
        'Ticket refinement analysis complete'
      );

      return this.createSuccessOutput(filteredResult, {
        durationMs: Date.now() - startTime,
        cached: false,
      });
    } catch (error) {
      return this.createErrorOutput(error instanceof Error ? error : String(error), {
        durationMs: Date.now() - startTime,
      });
    }
  }

  private buildContext(input: AgentInput<TicketRefinerInput>): string {
    const { title, description, readinessResult, existingComments, codebaseContext } = input.data;

    let context = `# Ticket: ${input.ticketIdentifier}

## Title
${title}

## Description
${description || '(no description provided)'}

## Readiness Analysis
- **Score**: ${readinessResult.score}/100
- **Ready**: ${readinessResult.ready ? 'Yes' : 'No'}
- **Recommended Action**: ${readinessResult.recommendedAction}

### Issues Identified
${readinessResult.issues.map((i) => `- ${i}`).join('\n') || '(none)'}

### Suggestions
${readinessResult.suggestions.map((s) => `- ${s}`).join('\n') || '(none)'}

### Reasoning
${readinessResult.reasoning}`;

    if (existingComments.length > 0) {
      const taskAgentComments = existingComments.filter((c) => c.isFromTaskAgent);
      const humanComments = existingComments.filter((c) => !c.isFromTaskAgent);

      if (taskAgentComments.length > 0) {
        context += '\n\n## Previous TaskAgent Questions\n';
        for (const comment of taskAgentComments) {
          context += `[${comment.createdAt.toISOString()}] ${comment.body.slice(0, 500)}\n`;
        }
      }

      if (humanComments.length > 0) {
        context += '\n\n## Human Responses\n';
        for (const comment of humanComments.slice(-5)) {
          context += `[${comment.createdAt.toISOString()}] ${comment.body.slice(0, 500)}\n`;
        }
      }
    }

    if (codebaseContext) {
      context += `\n\n## Codebase Context\n${codebaseContext}`;
    }

    context += `\n\n---\n
Based on the above analysis, determine what questions or clarifications would help a coding agent implement this ticket successfully.

If previous questions have been answered in the human responses, do NOT re-ask them.
Focus on remaining gaps and unanswered questions.`;

    return context;
  }

  private filterAnsweredQuestions(
    result: TicketRefinerOutput,
    existingComments: TicketRefinerInput['existingComments']
  ): TicketRefinerOutput {
    // Build a lowercase version of all human responses for matching
    const humanResponses = existingComments
      .filter((c) => !c.isFromTaskAgent)
      .map((c) => c.body.toLowerCase())
      .join(' ');

    // Filter out questions that seem to be addressed in responses
    const filteredQuestions = result.questions.filter((q) => {
      // Extract key terms from the question
      const questionTerms = q.question
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 4); // Skip short words

      // Check if at least some key terms appear in responses
      const matchingTerms = questionTerms.filter((term) => humanResponses.includes(term));

      // If more than 50% of key terms are in responses, consider it answered
      if (questionTerms.length > 0 && matchingTerms.length / questionTerms.length > 0.5) {
        return false;
      }

      return true;
    });

    // NOTE: We intentionally do NOT auto-transition to 'ready' here anymore.
    // The score threshold check in execute() handles enforcing the READY_THRESHOLD.
    // If all questions were filtered but score is low, execute() will add a default question.
    return {
      ...result,
      questions: filteredQuestions,
      // Keep the original action - score enforcement happens in execute()
      // This prevents auto-transitioning to 'ready' when score is below threshold
    };
  }

  /**
   * Format questions as individual comments for Linear
   * Returns an array of comment strings, one per question
   * Multiple choice questions are formatted with checkboxes
   */
  formatQuestionsAsComments(output: TicketRefinerOutput, mentionPrefix?: string): string[] {
    if (output.action === 'ready') {
      return [];
    }

    const mention = mentionPrefix || '';

    if (output.action === 'blocked') {
      return [`${mention}⚠️ Blocked: ${output.blockerReason || 'Unknown blocker'}`];
    }

    const comments: string[] = [];

    // Sort questions by priority: critical first, then important, then nice_to_have
    const sortedQuestions = [...output.questions].sort((a, b) => {
      const priorityOrder = { critical: 0, important: 1, nice_to_have: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    // Limit to top 3 most important questions to avoid spam
    const topQuestions = sortedQuestions.slice(0, 3);

    for (const q of topQuestions) {
      const priorityLabel = q.priority === 'critical' ? '❗' : q.priority === 'important' ? '❓' : '💭';

      if (q.options && q.options.length > 0) {
        // Multiple choice question with checkboxes
        const selectHint = q.allowMultiple ? '(select all that apply)' : '(select one)';
        let comment = `${mention}${priorityLabel} ${q.question} ${selectHint}\n`;
        for (const option of q.options) {
          comment += `- [ ] ${option}\n`;
        }
        comments.push(comment.trim());
      } else {
        // Open-ended question
        comments.push(`${mention}${priorityLabel} ${q.question}`);
      }
    }

    return comments;
  }

  /**
   * @deprecated Use formatQuestionsAsComments instead
   */
  formatQuestionsForLinear(output: TicketRefinerOutput, _ticketIdentifier: string, mentionPrefix?: string): string {
    const comments = this.formatQuestionsAsComments(output, mentionPrefix);
    return comments.join('\n\n');
  }
}

export const ticketRefinerAgent = new TicketRefinerAgent();
