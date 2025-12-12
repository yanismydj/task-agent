import {
  BaseAgent,
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
} from '../core/index.js';
import { z } from 'zod';

const CONSOLIDATOR_SYSTEM_PROMPT = `You are a senior product manager writing a clear, actionable ticket description.

Given the original ticket and the Q&A clarification discussion, rewrite the ticket description following product management best practices.

## Output Structure (use this exact format):

### Overview
One paragraph explaining the goal and context. What problem does this solve? Who benefits?

### Requirements
Bullet points of specific, measurable requirements derived from the Q&A. Each requirement should be:
- Specific (not vague)
- Actionable (developer knows exactly what to do)
- Derived from the clarification answers

### Technical Details
Any technical specifications, constraints, or implementation notes from the discussion.

### Acceptance Criteria
Checklist format (- [ ]) that defines "done". Each item should be testable.

## Guidelines:
- Replace the original description entirely with this new consolidated version
- Extract concrete requirements from checkbox answers (checked items = requirements)
- Don't reference the Q&A discussion - write as if these requirements were always known
- Be concise but complete - a developer should understand exactly what to build
- If answers mentioned specific technologies, files, or approaches, include them`;

const CONSOLIDATOR_SCHEMA = {
  type: 'object',
  properties: {
    consolidatedDescription: {
      type: 'string',
      description: 'The improved, consolidated ticket description in Markdown format',
    },
    summary: {
      type: 'string',
      description: 'A one-line summary of what was clarified from the Q&A',
    },
  },
  required: ['consolidatedDescription', 'summary'],
  additionalProperties: false,
} as const;

export const DescriptionConsolidatorInputSchema = z.object({
  title: z.string(),
  originalDescription: z.string(),
  comments: z.array(z.object({
    body: z.string(),
    isFromTaskAgent: z.boolean(),
    createdAt: z.date(),
  })),
});

export const DescriptionConsolidatorOutputSchema = z.object({
  consolidatedDescription: z.string(),
  summary: z.string(),
});

export type DescriptionConsolidatorInput = z.infer<typeof DescriptionConsolidatorInputSchema>;
export type DescriptionConsolidatorOutput = z.infer<typeof DescriptionConsolidatorOutputSchema>;

export class DescriptionConsolidatorAgent extends BaseAgent<DescriptionConsolidatorInput, DescriptionConsolidatorOutput> {
  readonly config: AgentConfig = {
    type: 'ticket-refiner', // Reuse the same type for model selection
    name: 'DescriptionConsolidator',
    description: 'Consolidates Q&A into a refined ticket description',
    modelTier: 'standard',
    cacheable: false,
    timeoutMs: 30000,
  };

  readonly inputSchema = DescriptionConsolidatorInputSchema;
  readonly outputSchema = DescriptionConsolidatorOutputSchema;

  async execute(input: AgentInput<DescriptionConsolidatorInput>): Promise<AgentOutput<DescriptionConsolidatorOutput>> {
    const logger = this.getLogger();
    const startTime = Date.now();

    const context = this.buildContext(input);

    try {
      const result = await this.callClaude<DescriptionConsolidatorOutput>(
        CONSOLIDATOR_SYSTEM_PROMPT,
        context,
        CONSOLIDATOR_SCHEMA,
        { maxTokens: 2048 }
      );

      logger.info(
        {
          ticketId: input.ticketIdentifier,
          summaryLength: result.summary.length,
          descriptionLength: result.consolidatedDescription.length,
        },
        'Description consolidated'
      );

      return this.createSuccessOutput(result, {
        durationMs: Date.now() - startTime,
        cached: false,
      });
    } catch (error) {
      return this.createErrorOutput(error instanceof Error ? error : String(error), {
        durationMs: Date.now() - startTime,
      });
    }
  }

  private buildContext(input: AgentInput<DescriptionConsolidatorInput>): string {
    const { title, originalDescription, comments } = input.data;

    // Separate TaskAgent questions from human answers
    const taskAgentComments = comments.filter(c => c.isFromTaskAgent);
    const humanComments = comments.filter(c => !c.isFromTaskAgent);

    let context = `# Ticket: ${input.ticketIdentifier}

## Title
${title}

## Original Description
${originalDescription || '(no description provided)'}

## Questions Asked by TaskAgent
`;

    for (const comment of taskAgentComments) {
      context += `\n${comment.body}\n`;
    }

    context += `\n## Human Responses\n`;

    for (const comment of humanComments) {
      context += `\n${comment.body}\n`;
    }

    context += `\n---
Based on the above Q&A, create a consolidated description that clearly specifies what needs to be built.
Include all the requirements that emerged from the answered questions.`;

    return context;
  }
}

export const descriptionConsolidatorAgent = new DescriptionConsolidatorAgent();
