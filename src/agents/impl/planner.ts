import { spawn, ChildProcess, execSync } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../../config.js';
import { createChildLogger } from '../../utils/logger.js';
import { z } from 'zod';
import {
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
  type Agent,
  AgentExecutionError,
  AgentTimeoutError,
} from '../core/index.js';

const logger = createChildLogger({ module: 'planner-agent' });

// Find the claude binary path at startup
function findClaudePath(): string {
  try {
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (claudePath) {
      return claudePath;
    }
  } catch {
    // which failed, try common locations
  }
  return 'npx';
}

const CLAUDE_PATH = findClaudePath();
const USE_NPX = CLAUDE_PATH === 'npx';

// Input/Output schemas for PlannerAgent
export const PlannerInputSchema = z.object({
  ticketIdentifier: z.string(),
  title: z.string(),
  description: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
});

export type PlannerInput = z.infer<typeof PlannerInputSchema>;

export const PlannerOutputSchema = z.object({
  success: z.boolean(),
  questions: z.array(z.string()).optional(), // Questions Claude asked
  plan: z.string().optional(), // Final consolidated plan
  error: z.string().optional(),
  output: z.string(), // Raw output for debugging
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/**
 * PlannerAgent runs Claude Code in planning mode (--permission-mode plan)
 * to gather requirements through Q&A before implementation.
 */
export class PlannerAgent implements Agent<PlannerInput, PlannerOutput> {
  readonly config: AgentConfig = {
    type: 'code-executor', // Reuse code-executor type since it's similar
    name: 'Planner',
    description: 'Runs Claude Code in planning mode for requirement gathering',
    modelTier: 'advanced',
    cacheable: false,
    maxConcurrent: config.agents.maxConcurrent,
    timeoutMs: config.agents.timeoutMinutes * 60 * 1000,
  };

  readonly inputSchema = PlannerInputSchema;
  readonly outputSchema = PlannerOutputSchema;

  private runningProcesses: Map<string, ChildProcess> = new Map();

  validateInput(input: unknown): PlannerInput {
    return this.inputSchema.parse(input);
  }

  async execute(
    input: AgentInput<PlannerInput>
  ): Promise<AgentOutput<PlannerOutput>> {
    const startTime = Date.now();
    const { ticketIdentifier, title, description, worktreePath } = input.data;

    logger.info(
      { ticketId: ticketIdentifier, worktree: worktreePath },
      'Starting Claude Code in planning mode'
    );

    try {
      const result = await this.runClaudePlanMode(
        ticketIdentifier,
        title,
        description,
        worktreePath
      );
      const durationMs = Date.now() - startTime;

      return {
        success: result.success,
        data: result,
        metadata: {
          modelUsed: 'claude-code-plan-mode',
          durationMs,
          cached: false,
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (error instanceof AgentTimeoutError || error instanceof AgentExecutionError) {
        return {
          success: false,
          error: error.message,
          metadata: {
            modelUsed: 'claude-code-plan-mode',
            durationMs,
            cached: false,
          },
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          modelUsed: 'claude-code-plan-mode',
          durationMs,
          cached: false,
        },
      };
    }
  }

  private async runClaudePlanMode(
    ticketIdentifier: string,
    title: string,
    description: string,
    worktreePath: string
  ): Promise<PlannerOutput> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timeoutMs = this.config.timeoutMs!;

      // Build prompt for planning mode
      const prompt = `# Ticket: ${ticketIdentifier}

## Title
${title}

## Description
${description}

Please analyze this ticket and ask any clarifying questions needed to fully understand the requirements before implementation.`;

      // Build args for Claude Code in plan mode
      const baseArgs = [
        '-p', prompt,
        '--permission-mode', 'plan', // Planning mode - only asks questions
        '--output-format', 'stream-json',
        '--verbose',
      ];

      const args = USE_NPX
        ? ['@anthropic-ai/claude-code', ...baseArgs]
        : baseArgs;

      // Verify worktree exists
      if (!fs.existsSync(worktreePath)) {
        reject(new AgentExecutionError(
          'planner',
          `Worktree does not exist: ${worktreePath}`,
          ticketIdentifier
        ));
        return;
      }

      logger.info(
        { ticketId: ticketIdentifier, cwd: worktreePath },
        'Spawning Claude Code in plan mode'
      );

      const childProcess = spawn(USE_NPX ? 'npx' : CLAUDE_PATH, args, {
        cwd: worktreePath,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.anthropic.apiKey,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.runningProcesses.set(ticketIdentifier, childProcess);

      const timeout = setTimeout(() => {
        logger.warn({ ticketId: ticketIdentifier }, 'Planning mode timed out');
        childProcess.kill('SIGTERM');
        this.runningProcesses.delete(ticketIdentifier);
        reject(new AgentTimeoutError(
          'planner',
          ticketIdentifier,
          timeoutMs
        ));
      }, timeoutMs);

      // Capture stdout
      childProcess.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        logger.debug({ ticketId: ticketIdentifier, chunk: chunk.slice(0, 200) }, 'Plan mode output');
      });

      // Capture stderr
      childProcess.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        logger.debug({ ticketId: ticketIdentifier, chunk: chunk.slice(0, 200) }, 'Plan mode stderr');
      });

      childProcess.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(ticketIdentifier);
        logger.error({ ticketId: ticketIdentifier, error: error.message }, 'Planning process error');
        reject(new AgentExecutionError('planner', error.message, ticketIdentifier));
      });

      childProcess.on('close', (code: number | null) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(ticketIdentifier);

        logger.info(
          { ticketId: ticketIdentifier, exitCode: code, outputLength: output.length },
          'Planning mode process closed'
        );

        // Parse questions from output
        const questions = this.parseQuestions(output);

        if (code === 0) {
          resolve({
            success: true,
            questions,
            output,
          });
        } else {
          resolve({
            success: false,
            error: `Planning mode exited with code ${code}`,
            output,
          });
        }
      });
    });
  }

  /**
   * Parse questions from Claude Code output
   * Questions typically appear in the output as numbered or bulleted items
   */
  private parseQuestions(output: string): string[] {
    const questions: string[] = [];
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      // Look for question patterns
      // - Numbered: "1. What is..."
      // - Bulleted: "- What is..."
      // - Direct: "What is...?"
      const numberedMatch = line.match(/^\d+\.\s+(.+\?)/);
      const bulletMatch = line.match(/^[-*]\s+(.+\?)/);
      const directMatch = line.match(/^([A-Z].+\?)\s*$/);

      if (numberedMatch && numberedMatch[1]) {
        questions.push(numberedMatch[1]);
      } else if (bulletMatch && bulletMatch[1]) {
        questions.push(bulletMatch[1]);
      } else if (directMatch && directMatch[1] && !line.startsWith('//') && !line.startsWith('#')) {
        questions.push(directMatch[1]);
      }
    }

    return questions;
  }

  /**
   * Stop a running planning process
   */
  stop(ticketIdentifier: string): void {
    const process = this.runningProcesses.get(ticketIdentifier);
    if (process) {
      logger.info({ ticketId: ticketIdentifier }, 'Stopping planning process');
      process.kill('SIGTERM');
      this.runningProcesses.delete(ticketIdentifier);
    }
  }

  /**
   * Stop all running processes
   */
  stopAll(): void {
    for (const [ticketId, process] of this.runningProcesses.entries()) {
      logger.info({ ticketId }, 'Stopping planning process');
      process.kill('SIGTERM');
    }
    this.runningProcesses.clear();
  }
}

export const plannerAgent = new PlannerAgent();
