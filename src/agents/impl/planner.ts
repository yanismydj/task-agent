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
interface RunningProcess {
  process: ChildProcess;
  ticketId: string;
  recentOutput: string[];
  startedAt: Date;
}

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

  private runningProcesses: Map<string, RunningProcess> = new Map();
  private jsonBuffer: Map<string, string> = new Map(); // Buffer for incomplete JSON lines
  private readonly MAX_OUTPUT_LINES = 10;

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
      // Plan mode is inherently read-only - no permission skipping needed
      const baseArgs = [
        '--permission-mode', 'plan',
        '-p', prompt,
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
          CLAUDE_FLOW_NON_INTERACTIVE: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin to prevent hanging
      });

      const processEntry: RunningProcess = {
        process: childProcess,
        ticketId: ticketIdentifier,
        recentOutput: [],
        startedAt: new Date(),
      };
      this.runningProcesses.set(ticketIdentifier, processEntry);

      const timeout = setTimeout(() => {
        logger.warn({ ticketId: ticketIdentifier }, 'Planning mode timed out');
        childProcess.kill('SIGTERM');
        this.runningProcesses.delete(ticketIdentifier);
        this.clearJsonBuffer(ticketIdentifier);
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
        this.appendRecentOutput(processEntry, chunk, ticketIdentifier);
        logger.debug({ ticketId: ticketIdentifier, chunk: chunk.slice(0, 200) }, 'Plan mode output');
      });

      // Capture stderr
      childProcess.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        this.appendRecentOutput(processEntry, chunk, ticketIdentifier);
        logger.debug({ ticketId: ticketIdentifier, chunk: chunk.slice(0, 200) }, 'Plan mode stderr');
      });

      childProcess.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(ticketIdentifier);
        this.clearJsonBuffer(ticketIdentifier);
        logger.error({ ticketId: ticketIdentifier, error: error.message }, 'Planning process error');
        reject(new AgentExecutionError('planner', error.message, ticketIdentifier));
      });

      childProcess.on('close', (code: number | null) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(ticketIdentifier);
        this.clearJsonBuffer(ticketIdentifier);

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
    const entry = this.runningProcesses.get(ticketIdentifier);
    if (entry) {
      logger.info({ ticketId: ticketIdentifier }, 'Stopping planning process');
      entry.process.kill('SIGTERM');
      this.runningProcesses.delete(ticketIdentifier);
    }
  }

  /**
   * Stop all running processes
   */
  stopAll(): void {
    for (const [ticketId, entry] of this.runningProcesses.entries()) {
      logger.info({ ticketId }, 'Stopping planning process');
      entry.process.kill('SIGTERM');
    }
    this.runningProcesses.clear();
  }

  /**
   * Get list of running agents for UI display
   */
  getRunningAgents(): Array<{ id: string; ticketId: string; recentOutput: string[]; startedAt: Date }> {
    return Array.from(this.runningProcesses.entries()).map(([id, entry]) => ({
      id,
      ticketId: entry.ticketId,
      recentOutput: entry.recentOutput,
      startedAt: entry.startedAt,
    }));
  }

  /**
   * Append text to recent output, keeping only the last N lines
   * Handles stream-json format from Claude Code
   */
  private appendRecentOutput(entry: RunningProcess, text: string, processId: string): void {
    // Get or create buffer for this process
    let buffer = this.jsonBuffer.get(processId) || '';
    buffer += text;

    // Process complete lines (ending with newline)
    const lines = buffer.split('\n');

    // Keep the last incomplete line in the buffer
    const lastLine = lines.pop() || '';
    this.jsonBuffer.set(processId, lastLine);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Try to parse as JSON (stream-json format)
      const displayLine = this.extractDisplayLine(trimmed);
      if (!displayLine) continue;

      // Truncate long lines for display
      const truncated = displayLine.length > 80 ? displayLine.slice(0, 77) + '...' : displayLine;
      entry.recentOutput.push(truncated);

      // Keep only the last N lines
      if (entry.recentOutput.length > this.MAX_OUTPUT_LINES) {
        entry.recentOutput.shift();
      }
    }
  }

  /**
   * Clear the JSON buffer for a process (call on process exit)
   */
  private clearJsonBuffer(processId: string): void {
    this.jsonBuffer.delete(processId);
  }

  /**
   * Extract a human-readable line from stream-json output
   */
  private extractDisplayLine(line: string): string | null {
    // Try to parse as JSON
    if (line.trim().startsWith('{')) {
      try {
        const json = JSON.parse(line) as Record<string, unknown>;

        // Handle different message types from Claude Code stream-json
        const type = json.type as string | undefined;

        if (type === 'assistant' && json.message) {
          const msg = json.message as { content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> };
          if (msg.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                // Clean up the text - remove markdown formatting for display
                const cleanText = block.text
                  .replace(/```[\s\S]*?```/g, '[code]') // Replace code blocks
                  .replace(/\n+/g, ' ') // Collapse newlines
                  .trim();
                return `💬 ${cleanText.slice(0, 80)}`;
              }
              if (block.type === 'tool_use' && block.name) {
                // Show tool name with relevant context from input
                const input = block.input;
                let context = '';
                if (input) {
                  if (block.name === 'Read' && input.file_path) {
                    const filePath = String(input.file_path);
                    context = ` → ${filePath.split('/').slice(-2).join('/')}`;
                  } else if (block.name === 'Grep' && input.pattern) {
                    context = ` → "${input.pattern}"`;
                  } else if (block.name === 'Glob' && input.pattern) {
                    context = ` → ${input.pattern}`;
                  }
                }
                return `🔧 ${block.name}${context}`;
              }
            }
          }
        }

        // Skip 'user' type messages - these are tool results and aren't useful to display
        if (type === 'user') {
          return null;
        }

        if (type === 'result') {
          const result = json.result as string | undefined;
          if (result) {
            const cleanResult = result.replace(/\n+/g, ' ').trim();
            return `✅ ${cleanResult.slice(0, 60)}`;
          }
          if (json.is_error) {
            return `❌ Error: ${(json.error as string) || 'Unknown error'}`;
          }
        }

        if (type === 'system' && json.message) {
          return `ℹ️ ${String(json.message).slice(0, 60)}`;
        }

        // Skip other internal message types that aren't useful to display
        if (type === 'content_block_start' || type === 'content_block_delta' || type === 'content_block_stop') {
          return null;
        }

        return null;
      } catch {
        // Not valid JSON, treat as plain text
      }
    }

    // Plain text output (non-JSON)
    const trimmed = line.trim();
    // Skip empty or very short lines
    if (trimmed.length < 3) return null;
    return trimmed;
  }
}

export const plannerAgent = new PlannerAgent();
