import { spawn, ChildProcess, execSync } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../../config.js';
import { createChildLogger } from '../../utils/logger.js';

// Find the claude binary path at startup
function findClaudePath(): string {
  try {
    // Try to find claude in PATH
    const claudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (claudePath) {
      return claudePath;
    }
  } catch {
    // which failed, try common locations
  }

  // Fallback to npx which should always work if @anthropic-ai/claude-code is installed
  return 'npx';
}

const CLAUDE_PATH = findClaudePath();
const USE_NPX = CLAUDE_PATH === 'npx';
import {
  type AgentConfig,
  type AgentInput,
  type AgentOutput,
  CodeExecutorInputSchema,
  CodeExecutorOutputSchema,
  type CodeExecutorInput,
  type CodeExecutorOutput,
  type Agent,
  AgentExecutionError,
  AgentTimeoutError,
} from '../core/index.js';

const logger = createChildLogger({ module: 'code-executor' });

export class CodeExecutorAgent implements Agent<CodeExecutorInput, CodeExecutorOutput> {
  readonly config: AgentConfig = {
    type: 'code-executor',
    name: 'CodeExecutor',
    description: 'Executes Claude Code CLI for implementation',
    modelTier: 'advanced', // Uses external Claude Code
    cacheable: false,
    maxConcurrent: config.agents.maxConcurrent,
    timeoutMs: config.agents.timeoutMinutes * 60 * 1000,
  };

  readonly inputSchema = CodeExecutorInputSchema;
  readonly outputSchema = CodeExecutorOutputSchema;

  private runningProcesses: Map<string, { process: ChildProcess; ticketId: string }> = new Map();

  validateInput(input: unknown): CodeExecutorInput {
    return this.inputSchema.parse(input);
  }

  async execute(input: AgentInput<CodeExecutorInput>): Promise<AgentOutput<CodeExecutorOutput>> {
    const startTime = Date.now();
    const { ticketIdentifier, prompt, worktreePath, branchName } = input.data;

    logger.info(
      { ticketId: ticketIdentifier, worktree: worktreePath, branch: branchName },
      'Starting Claude Code execution'
    );

    try {
      const result = await this.runClaudeCode(ticketIdentifier, prompt, worktreePath);
      const durationMs = Date.now() - startTime;

      return {
        success: result.success,
        data: result,
        metadata: {
          modelUsed: 'claude-code-cli',
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
            modelUsed: 'claude-code-cli',
            durationMs,
            cached: false,
          },
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          modelUsed: 'claude-code-cli',
          durationMs,
          cached: false,
        },
      };
    }
  }

  private async runClaudeCode(
    ticketIdentifier: string,
    prompt: string,
    worktreePath: string
  ): Promise<CodeExecutorOutput> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timeoutMs = this.config.timeoutMs!;

      // Build args - if using npx, we need to prefix with @anthropic-ai/claude-code
      const args = USE_NPX
        ? ['@anthropic-ai/claude-code', '--print', '--dangerously-skip-permissions', prompt]
        : ['--print', '--dangerously-skip-permissions', prompt];

      // Verify worktree exists before spawning
      if (!fs.existsSync(worktreePath)) {
        reject(new AgentExecutionError(
          'code-executor',
          ticketIdentifier,
          `Worktree path does not exist: ${worktreePath}. The worktree may need to be recreated.`,
          false // Don't retry - worktree issue needs to be fixed
        ));
        return;
      }

      logger.info(
        { ticketId: ticketIdentifier, claudePath: CLAUDE_PATH, useNpx: USE_NPX, cwd: worktreePath },
        'Spawning Claude Code'
      );

      const childProcess = spawn(
        CLAUDE_PATH,
        args,
        {
          cwd: worktreePath,
          env: { ...process.env },
        }
      );

      const processId = `exec-${ticketIdentifier}-${Date.now()}`;
      this.runningProcesses.set(processId, { process: childProcess, ticketId: ticketIdentifier });

      // Set timeout
      const timeout = setTimeout(() => {
        logger.warn({ ticketId: ticketIdentifier }, 'Claude Code execution timed out');
        this.killProcess(processId);
        reject(new AgentTimeoutError('code-executor', ticketIdentifier, timeoutMs));
      }, timeoutMs);

      childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        logger.debug({ ticketId: ticketIdentifier, bytes: text.length }, 'Claude Code output');
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        logger.warn({ ticketId: ticketIdentifier, stderr: text.slice(0, 200) }, 'Claude Code stderr');
      });

      childProcess.on('close', (code: number | null) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(processId);

        const result = this.parseOutput(output, code, ticketIdentifier);
        resolve(result);
      });

      childProcess.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(processId);
        reject(new AgentExecutionError(
          'code-executor',
          ticketIdentifier,
          `Process error: ${error.message}`,
          true,
          error
        ));
      });
    });
  }

  private parseOutput(output: string, exitCode: number | null, ticketIdentifier: string): CodeExecutorOutput {
    // Extract PR URL if present
    const prUrlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    const prUrl = prUrlMatch?.[0];

    // Extract commit SHA if present
    const commitMatch = output.match(/commit ([a-f0-9]{40})/i);
    const commitSha = commitMatch?.[1];

    // Detect task completion status
    const taskFailed = output.includes('TASK_FAILED');

    // Try to extract files modified (common git output patterns)
    const filesModified: string[] = [];
    const fileMatches = output.matchAll(/(?:create|modify|delete|rename)(?:d)?\s+(?:mode \d+ )?(.+?)(?:\s|$)/gi);
    for (const match of fileMatches) {
      if (match[1]) {
        filesModified.push(match[1].trim());
      }
    }

    // Determine success
    let success = false;
    let error: string | undefined;

    if (exitCode === 0) {
      if (taskFailed) {
        success = false;
        const failedMatch = output.match(/TASK_FAILED[:\s]*(.+?)(?:\n|$)/);
        error = failedMatch?.[1] || 'Task marked as failed by agent';
      } else {
        success = true;
      }
    } else {
      success = false;
      error = `Process exited with code ${exitCode}`;
    }

    logger.info(
      { ticketId: ticketIdentifier, success, prUrl, exitCode },
      'Claude Code execution completed'
    );

    return {
      success,
      prUrl,
      commitSha,
      filesModified,
      error,
      output,
    };
  }

  private killProcess(processId: string): void {
    const entry = this.runningProcesses.get(processId);
    if (entry && !entry.process.killed) {
      entry.process.kill('SIGTERM');
      setTimeout(() => {
        if (!entry.process.killed) {
          entry.process.kill('SIGKILL');
        }
      }, 5000);
    }
    this.runningProcesses.delete(processId);
  }

  killAllProcesses(): void {
    for (const [processId] of this.runningProcesses) {
      this.killProcess(processId);
    }
  }

  getRunningCount(): number {
    return this.runningProcesses.size;
  }

  getRunningTickets(): string[] {
    return Array.from(this.runningProcesses.values()).map((e) => e.ticketId);
  }
}

export const codeExecutorAgent = new CodeExecutorAgent();
