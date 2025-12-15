import { z } from 'zod';
import {
  BaseAgent,
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
} from '../core/index.js';

// Input schema - takes raw planning output + ticket context
export const PlanQuestionExtractorInputSchema = z.object({
  ticketTitle: z.string(),
  ticketDescription: z.string(),
  rawPlanOutput: z.string(), // Raw output from Claude Code plan mode
});

export type PlanQuestionExtractorInput = z.infer<typeof PlanQuestionExtractorInputSchema>;

// Question structure matching the refiner's format
const QuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  allowMultiple: z.boolean(),
  priority: z.enum(['critical', 'important', 'nice_to_have']),
});

// Output schema - structured questions + clean plan content
export const PlanQuestionExtractorOutputSchema = z.object({
  questions: z.array(QuestionSchema),
  planContent: z.string(), // Plan with questions section removed
});

export type PlanQuestionExtractorOutput = z.infer<typeof PlanQuestionExtractorOutputSchema>;
export type ExtractedQuestion = z.infer<typeof QuestionSchema>;

const EXTRACTOR_SYSTEM_PROMPT = `You are analyzing the output from a planning session where Claude Code explored a codebase and generated implementation insights.

Your job is to:
1. **Extract any clarifying questions** that Claude asked during planning (questions about requirements, preferences, edge cases, etc.)
2. **Generate 2-5 multiple choice options** for each question to make it easy for users to respond by checking boxes
3. **Separate the plan content from the questions** - return only the implementation plan/analysis without the questions section

Guidelines for questions:
- Each question should be actionable and help clarify implementation decisions
- Options should be mutually exclusive (single select) OR complementary (multi-select)
- Include an "Other" option only when truly needed
- Prioritize questions: "critical" = blocks implementation, "important" = affects quality, "nice_to_have" = polish

Guidelines for plan content:
- Include implementation steps, file changes, architecture decisions
- Remove sections like "Questions", "Before I proceed", "I'd like to clarify"
- Keep technical analysis, requirements, and acceptance criteria

If Claude didn't ask any questions in the output, return an empty questions array and the full content as planContent.`;

const EXTRACTOR_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The clarifying question to ask (keep concise)',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Multiple choice options (2-5 items). Make them specific and actionable.',
          },
          allowMultiple: {
            type: 'boolean',
            description: 'If true, user can select multiple options. If false, single choice only.',
          },
          priority: {
            type: 'string',
            enum: ['critical', 'important', 'nice_to_have'],
            description: 'How important is this question for implementation',
          },
        },
        required: ['question', 'options', 'allowMultiple', 'priority'],
        additionalProperties: false,
      },
      description: 'List of clarifying questions extracted from the planning output',
    },
    planContent: {
      type: 'string',
      description: 'The implementation plan/analysis with questions section removed. Include technical details, file changes, architecture decisions.',
    },
  },
  required: ['questions', 'planContent'],
  additionalProperties: false,
} as const;

export class PlanQuestionExtractorAgent extends BaseAgent<PlanQuestionExtractorInput, PlanQuestionExtractorOutput> {
  readonly config: AgentConfig = {
    type: 'plan-question-extractor',
    name: 'PlanQuestionExtractor',
    description: 'Extracts structured questions with multiple-choice options from planning output',
    modelTier: 'standard', // Uses Sonnet for reliable extraction
    cacheable: false,
    timeoutMs: 60000,
  };

  readonly inputSchema = PlanQuestionExtractorInputSchema;
  readonly outputSchema = PlanQuestionExtractorOutputSchema;

  async execute(input: AgentInput<PlanQuestionExtractorInput>): Promise<AgentOutput<PlanQuestionExtractorOutput>> {
    const logger = this.getLogger();
    const startTime = Date.now();

    const context = this.buildContext(input);

    try {
      const result = await this.callClaude<PlanQuestionExtractorOutput>(
        EXTRACTOR_SYSTEM_PROMPT,
        context,
        EXTRACTOR_SCHEMA,
        { maxTokens: 4096 } // Allow longer output for plan content
      );

      logger.info(
        {
          ticketId: input.ticketIdentifier,
          questionCount: result.questions.length,
          planContentLength: result.planContent.length,
        },
        'Extracted questions from planning output'
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

  private buildContext(input: AgentInput<PlanQuestionExtractorInput>): string {
    const { ticketTitle, ticketDescription, rawPlanOutput } = input.data;

    // Extract readable text from stream-json output if needed
    const cleanedOutput = this.extractTextFromStreamJson(rawPlanOutput);

    return `# Ticket: ${input.ticketIdentifier}

## Title
${ticketTitle}

## Original Description
${ticketDescription || '(no description provided)'}

## Planning Session Output
The following is the raw output from Claude Code's planning session:

---
${cleanedOutput}
---

Please analyze this output and:
1. Extract any clarifying questions Claude asked (with multiple-choice options)
2. Return the plan content separately (without the questions section)`;
  }

  /**
   * Extract human-readable text from stream-json format output.
   * Claude Code outputs JSON lines with different message types.
   */
  private extractTextFromStreamJson(output: string): string {
    const lines = output.split('\n');
    let accumulatedText = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      try {
        const json = JSON.parse(trimmed) as Record<string, unknown>;
        const type = json.type as string | undefined;

        if (type === 'assistant' && json.message) {
          const msg = json.message as { content?: Array<{ type: string; text?: string }> };
          if (msg.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                accumulatedText += block.text + '\n';
              }
            }
          }
        } else if (type === 'content_block_delta') {
          const delta = json.delta as { text?: string } | undefined;
          if (delta?.text) {
            accumulatedText += delta.text;
          }
        }
      } catch {
        // Not valid JSON - might be plain text
        // Only include non-JSON lines if they look like content
        if (!trimmed.startsWith('{') && trimmed.length > 10) {
          accumulatedText += trimmed + '\n';
        }
      }
    }

    // If we extracted structured content, use it
    if (accumulatedText.trim().length > 50) {
      return accumulatedText.trim();
    }

    // Fallback: return original output if it's not stream-json
    return output;
  }
}

export const planQuestionExtractorAgent = new PlanQuestionExtractorAgent();
