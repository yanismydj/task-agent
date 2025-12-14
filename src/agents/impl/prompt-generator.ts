import {
  BaseAgent,
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
  PromptGeneratorInputSchema,
  PromptGeneratorOutputSchema,
  type PromptGeneratorInput,
  type PromptGeneratorOutput,
  agentCache,
} from '../core/index.js';

const PROMPT_GENERATOR_SYSTEM = `You are an expert at creating prompts for Claude Code, an AI coding assistant.

Your task is to transform a Linear ticket into an effective prompt that will guide Claude Code to successfully implement the requested changes.

Best practices for Claude Code prompts:
1. **Be specific about scope**: Clearly state what should and should not be changed
2. **Reference files**: Mention specific files, directories, or patterns to follow
3. **Include acceptance criteria**: Define what "done" looks like
4. **Set constraints**: Mention coding standards, testing requirements, PR conventions
5. **Warn about pitfalls**: Note any gotchas or common mistakes to avoid

The prompt should be comprehensive but focused. Claude Code works best with clear, actionable instructions.`;

const PROMPT_GENERATOR_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The complete prompt to send to Claude Code',
    },
    suggestedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files that Claude Code should examine or modify',
    },
    estimatedComplexity: {
      type: 'string',
      enum: ['simple', 'moderate', 'complex'],
      description: 'Estimated complexity of the implementation',
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Potential issues or things to watch out for',
    },
  },
  required: ['prompt', 'suggestedFiles', 'estimatedComplexity', 'warnings'],
  additionalProperties: false,
} as const;

export class PromptGeneratorAgent extends BaseAgent<PromptGeneratorInput, PromptGeneratorOutput> {
  readonly config: AgentConfig = {
    type: 'prompt-generator',
    name: 'PromptGenerator',
    description: 'Transforms tickets into optimized Claude Code prompts',
    modelTier: 'standard', // Uses Sonnet for quality
    cacheable: true,
    timeoutMs: 45000,
  };

  readonly inputSchema = PromptGeneratorInputSchema;
  readonly outputSchema = PromptGeneratorOutputSchema;

  getCacheKey(input: AgentInput<PromptGeneratorInput>): string {
    // Cache key based on ticket content hash
    const contentHash = this.hashContent(
      input.data.ticket.title +
      input.data.ticket.description +
      (input.data.ticket.acceptanceCriteria?.join('') ?? '')
    );
    return `prompt:${input.ticketId}:${contentHash}`;
  }

  async execute(input: AgentInput<PromptGeneratorInput>): Promise<AgentOutput<PromptGeneratorOutput>> {
    const logger = this.getLogger();
    const startTime = Date.now();

    // Check cache first
    const cacheKey = this.getCacheKey(input);
    const ticketUpdatedAt = input.context?.updatedAt as Date | undefined;

    if (ticketUpdatedAt) {
      const cached = agentCache.get<PromptGeneratorOutput>(cacheKey, ticketUpdatedAt);
      if (cached && cached.data) {
        logger.debug({ ticketId: input.ticketIdentifier }, 'Using cached prompt');
        return cached;
      }
    }

    // Build context for prompt generation
    const context = this.buildContext(input);

    try {
      const result = await this.callClaude<PromptGeneratorOutput>(
        PROMPT_GENERATOR_SYSTEM,
        context,
        PROMPT_GENERATOR_SCHEMA,
        { maxTokens: 4096 }
      );

      // Enhance the generated prompt with standard instructions
      const enhancedResult = this.enhancePrompt(result, input);

      const output = this.createSuccessOutput(enhancedResult, {
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
          complexity: enhancedResult.estimatedComplexity,
          warningCount: enhancedResult.warnings.length,
        },
        'Prompt generated'
      );

      return output;
    } catch (error) {
      return this.createErrorOutput(error instanceof Error ? error : String(error), {
        durationMs: Date.now() - startTime,
      });
    }
  }

  private buildContext(input: AgentInput<PromptGeneratorInput>): string {
    const { ticket, codebaseInfo, constraints, restartContext } = input.data;

    let context = `# Generate a Claude Code Prompt

## Ticket: ${ticket.identifier}

### Title
${ticket.title}

### Description
${ticket.description}`;

    if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      context += '\n\n### Acceptance Criteria\n';
      for (const criteria of ticket.acceptanceCriteria) {
        context += `- ${criteria}\n`;
      }
    }

    if (ticket.attachments && ticket.attachments.length > 0) {
      context += '\n\n### Attachments\n';
      context += 'The ticket has the following attachments that may provide visual context:\n';
      for (const attachment of ticket.attachments) {
        const title = attachment.title || 'Untitled attachment';
        context += `- ${title}: ${attachment.url}\n`;
      }
      context += '\nNote: Include instructions in the prompt for Claude Code to examine these attachments if they contain relevant visual information (UI mockups, error screenshots, etc.).\n';
    }

    // Add restart context if this is a restart scenario
    if (restartContext) {
      context += `\n\n## IMPORTANT: This is a Restart Scenario\n`;
      context += `This ticket has been worked on ${restartContext.previousAttemptCount} time(s) before.\n`;
      context += `Previous attempt status: ${restartContext.previousStatus}\n\n`;
      context += `### What Was Attempted Before\n`;
      context += `${restartContext.summary}\n\n`;

      if (restartContext.newComments.length > 0) {
        context += `### New Feedback from User\n`;
        context += `The user has provided the following feedback since the last attempt:\n\n`;

        for (const comment of restartContext.newComments) {
          if (comment.isFromUser) {
            const timestamp = comment.createdAt.toISOString();
            context += `**Comment (${timestamp}):**\n${comment.body}\n\n`;
          }
        }

        context += `\n**CRITICAL:** You must address ALL of the user's feedback above. This is a restart, so the user is expecting you to fix issues or incorporate their new requirements.\n`;
      } else {
        context += `\n**Note:** No new comments were added since the last attempt. Review the previous work and determine what needs to be fixed or improved.\n`;
      }
    }

    if (codebaseInfo) {
      context += '\n\n## Codebase Information\n';

      if (codebaseInfo.relevantFiles.length > 0) {
        context += '\n### Relevant Files\n';
        for (const file of codebaseInfo.relevantFiles) {
          context += `- ${file}\n`;
        }
      }

      if (codebaseInfo.patterns.length > 0) {
        context += '\n### Existing Patterns\n';
        for (const pattern of codebaseInfo.patterns) {
          context += `- ${pattern}\n`;
        }
      }

      if (codebaseInfo.conventions) {
        context += `\n### Coding Conventions\n${codebaseInfo.conventions}\n`;
      }
    }

    context += `\n\n## Constraints\n`;
    context += `- Branch naming: ${constraints.branchNaming}\n`;
    if (constraints.maxFiles) {
      context += `- Maximum files to modify: ${constraints.maxFiles}\n`;
    }
    if (constraints.testRequirements) {
      context += `- Testing requirements: ${constraints.testRequirements}\n`;
    }

    context += `\n\n---\n
Generate a comprehensive prompt for Claude Code that will help it successfully implement this ticket.`;

    if (restartContext) {
      context += `\n\n**SPECIAL INSTRUCTIONS FOR RESTART:**
- Clearly reference the previous attempt and what went wrong or needs improvement
- Emphasize the user's new feedback and requirements
- Make it clear this is a follow-up, not a fresh start
- The prompt should combine: (1) original requirements, (2) previous attempt context, and (3) new user feedback`;
    }

    context += `\nThe prompt should be actionable, specific, and include all necessary context.`;

    return context;
  }

  private enhancePrompt(result: PromptGeneratorOutput, input: AgentInput<PromptGeneratorInput>): PromptGeneratorOutput {
    const { ticket, constraints } = input.data;

    // Add standard instructions to the prompt
    const standardInstructions = `
IMPORTANT INSTRUCTIONS:
1. Read and understand the codebase before making changes
2. Implement the minimal changes needed to address the ticket
3. Write tests if appropriate for the changes
4. Commit your changes with a clear message referencing ${ticket.identifier}
5. Create a pull request with:
   - Title: "<brief description>"
   - Body: Summary of changes and link to the ticket
   - IMPORTANT: Include the Linear ticket link in the PR body:

     ## Related Linear Ticket
     ${ticket.url}

     This ensures the PR is properly linked to the Linear ticket.
6. Branch name should follow pattern: ${constraints.branchNaming}

STRICT CONSTRAINTS:
- Do NOT create markdown files (*.md) or documentation files unless explicitly requested in the ticket
- Do NOT create README files, IMPLEMENTATION.md, DESIGN.md, or similar documentation
- Do NOT create plan files or specification documents
- Focus ONLY on code implementation - write actual code, not documentation about code
- If the ticket asks for documentation, only then create markdown files

When done, output "TASK_COMPLETE" followed by the PR URL.
If you cannot complete the task, output "TASK_FAILED" followed by the reason.`;

    return {
      ...result,
      prompt: `${result.prompt}\n\n${standardInstructions}`,
    };
  }

  private hashContent(content: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}

export const promptGeneratorAgent = new PromptGeneratorAgent();
