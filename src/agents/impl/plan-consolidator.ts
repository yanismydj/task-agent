import { z } from 'zod';
import {
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
  type Agent,
} from '../core/index.js';
import { createChildLogger } from '../../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

const logger = createChildLogger({ module: 'plan-consolidator' });

// Input/Output schemas
export const PlanConsolidatorInputSchema = z.object({
  title: z.string(),
  originalDescription: z.string(),
  comments: z.array(z.object({
    body: z.string(),
    isFromTaskAgent: z.boolean(),
    createdAt: z.date(),
  })),
});

export type PlanConsolidatorInput = z.infer<typeof PlanConsolidatorInputSchema>;

export const PlanConsolidatorOutputSchema = z.object({
  consolidatedPlan: z.string(),
  summary: z.string(),
});

export type PlanConsolidatorOutput = z.infer<typeof PlanConsolidatorOutputSchema>;

/**
 * PlanConsolidatorAgent consolidates planning Q&A into a comprehensive plan
 * that gets inserted into the ticket description.
 */
export class PlanConsolidatorAgent implements Agent<PlanConsolidatorInput, PlanConsolidatorOutput> {
  readonly config: AgentConfig = {
    type: 'prompt-generator', // Reuse existing type
    name: 'PlanConsolidator',
    description: 'Consolidates planning Q&A into a comprehensive implementation plan',
    modelTier: 'standard',
    cacheable: false,
  };

  readonly inputSchema = PlanConsolidatorInputSchema;
  readonly outputSchema = PlanConsolidatorOutputSchema;
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }

  validateInput(input: unknown): PlanConsolidatorInput {
    return this.inputSchema.parse(input);
  }

  async execute(
    input: AgentInput<PlanConsolidatorInput>
  ): Promise<AgentOutput<PlanConsolidatorOutput>> {
    const startTime = Date.now();
    const { title, originalDescription, comments } = input.data;

    logger.info(
      { ticketId: input.ticketIdentifier, commentCount: comments.length },
      'Consolidating planning Q&A into implementation plan'
    );

    try {
      // Build conversation history from comments
      const conversation = this.buildConversation(comments);

      const systemPrompt = `You are a technical planning assistant helping consolidate a planning discussion into a comprehensive implementation plan.

Your task is to:
1. Review the planning questions and user responses
2. Create a clear, actionable implementation plan
3. Structure the plan with sections: Overview, Requirements, Technical Approach, Acceptance Criteria

The plan should be detailed enough for an AI coding agent to implement without further clarification.`;

      const userPrompt = `# Ticket: ${title}

## Original Description
${originalDescription}

## Planning Discussion
${conversation}

Please consolidate this planning discussion into a comprehensive implementation plan. The plan should include:

1. **Overview**: Brief summary of what needs to be implemented
2. **Requirements**: Detailed functional and technical requirements based on the Q&A
3. **Technical Approach**: Step-by-step implementation strategy
4. **Acceptance Criteria**: Clear criteria for when the implementation is complete

Format the plan in markdown. Be thorough and specific.`;

      const response = await this.anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
        ],
      });

      const firstContent = response.content[0];
      const consolidatedPlan = firstContent && firstContent.type === 'text'
        ? firstContent.text
        : '';

      if (!consolidatedPlan) {
        throw new Error('Failed to generate consolidated plan');
      }

      // Extract summary (first paragraph or first 200 chars)
      const summary = this.extractSummary(consolidatedPlan);

      const durationMs = Date.now() - startTime;

      return {
        success: true,
        data: {
          consolidatedPlan,
          summary,
        },
        metadata: {
          modelUsed: config.anthropic.model,
          durationMs,
          cached: false,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(
        { ticketId: input.ticketIdentifier, error: errorMessage },
        'Plan consolidation failed'
      );

      return {
        success: false,
        error: errorMessage,
        metadata: {
          modelUsed: config.anthropic.model,
          durationMs,
          cached: false,
        },
      };
    }
  }

  private buildConversation(comments: Array<{ body: string; isFromTaskAgent: boolean; createdAt: Date }>): string {
    // Sort by creation time
    const sorted = [...comments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let conversation = '';
    for (const comment of sorted) {
      const speaker = comment.isFromTaskAgent ? 'TaskAgent' : 'User';
      conversation += `**${speaker}**: ${comment.body}\n\n`;
    }

    return conversation;
  }

  private extractSummary(plan: string): string {
    // Try to extract the first paragraph under "Overview" section
    const overviewMatch = plan.match(/##?\s*Overview\s*\n+(.*?)(?=\n##|$)/is);
    if (overviewMatch && overviewMatch[1]) {
      const overview = overviewMatch[1].trim();
      return overview.length > 200 ? overview.slice(0, 200) + '...' : overview;
    }

    // Fallback: first 200 characters
    const firstPara = plan.split('\n\n')[0] || '';
    return firstPara.length > 200 ? firstPara.slice(0, 200) + '...' : firstPara;
  }
}

export const planConsolidatorAgent = new PlanConsolidatorAgent();
