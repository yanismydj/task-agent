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

const REFINER_SYSTEM_PROMPT = `You are a technical project manager helping prepare tickets for coding agents.

Your goal is to ask clarifying questions that will help a coding agent successfully implement the ticket. Focus on:

1. **Acceptance Criteria**: What exactly should the implementation achieve?
2. **Scope Boundaries**: What is explicitly in/out of scope?
3. **Technical Context**: Which files, components, or patterns should be used?
4. **Edge Cases**: What error scenarios or special cases should be handled?
5. **Testing**: How should the implementation be verified?

Guidelines for questions:
- Be specific and actionable
- Don't ask about things already answered in the description
- Focus on information the coding agent needs to succeed
- Prioritize questions as 'critical' (must have), 'important' (should have), or 'nice_to_have'
- Suggest improvements to the ticket description if appropriate

If the ticket is already well-specified despite a low readiness score, recommend action 'ready'.
If there are external blockers (dependencies, missing access), recommend action 'blocked'.`;

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
            description: 'The clarifying question to ask',
          },
          rationale: {
            type: 'string',
            description: 'Why this question is important for the coding agent',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'important', 'nice_to_have'],
            description: 'How important is this question',
          },
        },
        required: ['question', 'rationale', 'priority'],
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

    return {
      ...result,
      questions: filteredQuestions,
      // If all questions were filtered, mark as ready
      action: filteredQuestions.length === 0 && result.action === 'ask_questions'
        ? 'ready'
        : result.action,
    };
  }

  formatQuestionsForLinear(output: TicketRefinerOutput, ticketIdentifier: string, mentionPrefix?: string): string {
    if (output.action === 'ready') {
      return '';
    }

    const mention = mentionPrefix || '';

    if (output.action === 'blocked') {
      return `${mention}**[TaskAgent]** This ticket appears to be blocked:\n\n${output.blockerReason || 'Unknown blocker'}\n\nPlease resolve the blocker and update the ticket.`;
    }

    const criticalQuestions = output.questions.filter((q) => q.priority === 'critical');
    const importantQuestions = output.questions.filter((q) => q.priority === 'important');
    const niceToHaveQuestions = output.questions.filter((q) => q.priority === 'nice_to_have');

    let comment = `${mention}**[TaskAgent]** Before I can start working on ${ticketIdentifier}, I have some clarifying questions:\n\n`;

    if (criticalQuestions.length > 0) {
      comment += '### Critical Questions (must answer)\n';
      for (const q of criticalQuestions) {
        comment += `- **${q.question}**\n  _${q.rationale}_\n\n`;
      }
    }

    if (importantQuestions.length > 0) {
      comment += '### Important Questions\n';
      for (const q of importantQuestions) {
        comment += `- ${q.question}\n  _${q.rationale}_\n\n`;
      }
    }

    if (niceToHaveQuestions.length > 0) {
      comment += '### Nice to Have\n';
      for (const q of niceToHaveQuestions) {
        comment += `- ${q.question}\n`;
      }
      comment += '\n';
    }

    if (output.suggestedAcceptanceCriteria.length > 0) {
      comment += '### Suggested Acceptance Criteria\n';
      for (const criteria of output.suggestedAcceptanceCriteria) {
        comment += `- [ ] ${criteria}\n`;
      }
      comment += '\n';
    }

    comment += '---\n_Please respond to the questions above, and I will re-evaluate the ticket._';

    return comment;
  }
}

export const ticketRefinerAgent = new TicketRefinerAgent();
