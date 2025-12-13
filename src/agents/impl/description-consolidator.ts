import {
  BaseAgent,
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
} from '../core/index.js';
import { z } from 'zod';

const CONSOLIDATOR_SYSTEM_PROMPT = `You are a senior product manager writing concise, actionable ticket descriptions.

**CRITICAL: Keep descriptions between 150-300 words. Brevity is essential.**

Given the original ticket and Q&A discussion, write a focused description that a developer can act on immediately.

## Output Format (adapt as needed, skip empty sections):

**Goal**: 1-2 sentences on what to build and why.

**Requirements**: Brief bullet points of what's needed (from Q&A answers).

**Technical Notes**: Only if specific files, APIs, or approaches were mentioned.

**Done When**: 2-4 testable acceptance criteria as checkboxes.

## Guidelines:
- **150-300 words maximum** - trim ruthlessly, every word must earn its place
- Extract requirements from checkbox answers (checked = requirement)
- Don't reference the Q&A - write as if requirements were always known
- Skip sections that would be empty or redundant
- One clear sentence beats three vague ones

## Title Guidelines:
- Only suggest a new title if the original is vague or misleading
- Good: "Add dark mode toggle to settings" (concise, specific)
- If title is fine, omit suggestedTitle from response`;

const CONSOLIDATOR_SCHEMA = {
  type: 'object',
  properties: {
    consolidatedDescription: {
      type: 'string',
      description: 'The improved, consolidated ticket description in Markdown format',
    },
    suggestedTitle: {
      type: 'string',
      description: 'An improved title for the ticket if the original is vague or unclear. Null if original is fine.',
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
  suggestedTitle: z.string().optional(),
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
