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
import type { SessionRecord } from '../../sessions/index.js';

const logger = createChildLogger({ module: 'code-executor' });

/**
 * Context passed to execution methods for session tracking
 */
export interface ExecutionContext {
  /** Callback invoked when Claude Code's session ID is captured from output */
  onSessionIdCaptured?: (sessionId: string) => void;
}

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

  private runningProcesses: Map<string, { process: ChildProcess; ticketId: string; recentOutput: string[]; startedAt: Date }> = new Map();
  private readonly MAX_OUTPUT_LINES = 5; // Keep last N lines for UI display
  private jsonBuffer: Map<string, string> = new Map(); // Buffer for incomplete JSON lines
  private capturedSessionIds: Map<string, string> = new Map(); // processId -> Claude session ID

  validateInput(input: unknown): CodeExecutorInput {
    return this.inputSchema.parse(input);
  }

  async execute(
    input: AgentInput<CodeExecutorInput>,
    context?: ExecutionContext
  ): Promise<AgentOutput<CodeExecutorOutput>> {
    const startTime = Date.now();
    const { ticketIdentifier, prompt, worktreePath, branchName } = input.data;

    logger.info(
      { ticketId: ticketIdentifier, worktree: worktreePath, branch: branchName },
      'Starting Claude Code execution'
    );

    try {
      const result = await this.runClaudeCode(ticketIdentifier, prompt, worktreePath, context);
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
    worktreePath: string,
    context?: ExecutionContext
  ): Promise<CodeExecutorOutput> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timeoutMs = this.config.timeoutMs!;
      let sessionIdCaptured = false;

      // Build args for non-interactive/headless mode
      // See: https://github.com/ruvnet/claude-flow/wiki/Non-Interactive-Mode
      // Note: stream-json requires --verbose flag
      const baseArgs = [
        '-p', prompt,                      // Print mode with prompt
        '--dangerously-skip-permissions',  // Auto-approve all tool usage
        '--output-format', 'stream-json',  // Streaming JSON for real-time output
        '--verbose',                       // Required for stream-json
      ];
      const args = USE_NPX
        ? ['@anthropic-ai/claude-code', ...baseArgs]
        : baseArgs;

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
        { ticketId: ticketIdentifier, claudePath: CLAUDE_PATH, useNpx: USE_NPX, cwd: worktreePath, promptLength: prompt.length },
        'Spawning Claude Code'
      );

      const childProcess = spawn(
        CLAUDE_PATH,
        args,
        {
          cwd: worktreePath,
          env: {
            ...process.env,
            // Explicit non-interactive mode - prevents any TTY/interactive prompts
            CLAUDE_FLOW_NON_INTERACTIVE: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'], // No stdin needed - prompt is in args
        }
      );

      const processId = `exec-${ticketIdentifier}-${Date.now()}`;
      const processEntry = { process: childProcess, ticketId: ticketIdentifier, recentOutput: [] as string[], startedAt: new Date() };
      this.runningProcesses.set(processId, processEntry);

      // Set timeout
      const timeout = setTimeout(() => {
        logger.warn({ ticketId: ticketIdentifier }, 'Claude Code execution timed out');
        this.killProcess(processId);
        reject(new AgentTimeoutError('code-executor', ticketIdentifier, timeoutMs));
      }, timeoutMs);

      childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Update recent output for UI display
        this.appendRecentOutput(processEntry, text, processId);
        logger.debug({ ticketId: ticketIdentifier, bytes: text.length }, 'Claude Code output');

        // Try to capture session ID from stream-json output (only once)
        if (!sessionIdCaptured && context?.onSessionIdCaptured) {
          const sessionId = this.extractSessionIdFromOutput(text);
          if (sessionId) {
            sessionIdCaptured = true;
            this.capturedSessionIds.set(processId, sessionId);
            context.onSessionIdCaptured(sessionId);
            logger.info({ ticketId: ticketIdentifier, sessionId }, 'Captured Claude Code session ID');
          }
        }
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Update recent output for UI display (stderr too)
        this.appendRecentOutput(processEntry, text, processId);
        logger.warn({ ticketId: ticketIdentifier, stderr: text.slice(0, 200) }, 'Claude Code stderr');
      });

      childProcess.on('close', (code: number | null) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(processId);
        this.clearJsonBuffer(processId);
        this.capturedSessionIds.delete(processId);

        const result = this.parseOutput(output, code, ticketIdentifier);
        resolve(result);
      });

      childProcess.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(processId);
        this.clearJsonBuffer(processId);
        this.capturedSessionIds.delete(processId);
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
    // Try to parse JSON output first (preferred)
    const jsonResult = this.tryParseJsonOutput(output);
    if (jsonResult) {
      logger.info(
        { ticketId: ticketIdentifier, success: jsonResult.success, exitCode, hasJsonOutput: true },
        'Claude Code execution completed (JSON parsed)'
      );
      return jsonResult;
    }

    // Fallback to text parsing if JSON parsing fails
    logger.debug({ ticketId: ticketIdentifier }, 'Falling back to text output parsing');

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
      { ticketId: ticketIdentifier, success, prUrl, exitCode, hasJsonOutput: false },
      'Claude Code execution completed (text parsed)'
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

  /**
   * Try to parse JSON output from Claude Code's --output-format json mode
   */
  private tryParseJsonOutput(output: string): CodeExecutorOutput | null {
    try {
      // Claude Code JSON output may have multiple JSON objects (one per line in stream mode)
      // or a single complete JSON object. Try to find and parse the final/complete one.
      const lines = output.trim().split('\n');

      // Try parsing from the end (most complete result is usually last)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (line?.startsWith('{')) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;

            // Check if this looks like a Claude Code result
            if ('result' in parsed || 'error' in parsed || 'sessionId' in parsed) {
              return this.extractFromJsonResult(parsed, output);
            }
          } catch {
            // Not valid JSON, continue searching
          }
        }
      }

      // Also try parsing the entire output as a single JSON object
      if (output.trim().startsWith('{')) {
        const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
        return this.extractFromJsonResult(parsed, output);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract CodeExecutorOutput from parsed JSON result
   */
  private extractFromJsonResult(parsed: Record<string, unknown>, rawOutput: string): CodeExecutorOutput {
    // Extract common fields from Claude Code JSON output
    const result = parsed.result as string | undefined;
    const errorMsg = parsed.error as string | undefined;
    const isError = parsed.is_error as boolean | undefined;

    // Look for PR URL in the result text or in structured fields
    let prUrl: string | undefined;
    const prUrlMatch = (result || rawOutput).match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
    if (prUrlMatch) {
      prUrl = prUrlMatch[0];
    }

    // Look for commit SHA
    let commitSha: string | undefined;
    const commitMatch = (result || rawOutput).match(/commit ([a-f0-9]{40})/i);
    if (commitMatch) {
      commitSha = commitMatch[1];
    }

    // Determine success
    const success = !isError && !errorMsg && !result?.includes('TASK_FAILED');

    return {
      success,
      prUrl,
      commitSha,
      filesModified: [],
      error: errorMsg || (isError ? 'Task failed' : undefined),
      output: rawOutput,
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

  /**
   * Get detailed info about running agents for UI display
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
  private appendRecentOutput(entry: { recentOutput: string[]; ticketId?: string }, text: string, processId?: string): void {
    // Get or create buffer for this process
    const bufferId = processId || 'default';
    let buffer = this.jsonBuffer.get(bufferId) || '';
    buffer += text;

    // Process complete lines (ending with newline)
    const lines = buffer.split('\n');

    // Keep the last incomplete line in the buffer
    const lastLine = lines.pop() || '';
    this.jsonBuffer.set(bufferId, lastLine);

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
   * Extract Claude Code session ID from stream-json output
   */
  private extractSessionIdFromOutput(text: string): string | null {
    // Look for sessionId in JSON lines
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;

      try {
        const json = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof json.sessionId === 'string' && json.sessionId.length > 0) {
          return json.sessionId;
        }
        // Also check nested in message or result objects
        if (json.message && typeof (json.message as Record<string, unknown>).sessionId === 'string') {
          return (json.message as Record<string, unknown>).sessionId as string;
        }
      } catch {
        // Not valid JSON, skip
      }
    }
    return null;
  }

  /**
   * Resume an interrupted Claude Code session
   */
  async resumeSession(session: SessionRecord): Promise<CodeExecutorOutput> {
    if (!session.sessionId) {
      throw new AgentExecutionError(
        'code-executor',
        session.ticketIdentifier,
        'Cannot resume session: no Claude Code session ID was captured',
        false
      );
    }

    if (!fs.existsSync(session.worktreePath)) {
      throw new AgentExecutionError(
        'code-executor',
        session.ticketIdentifier,
        `Cannot resume session: worktree no longer exists at ${session.worktreePath}`,
        false
      );
    }

    logger.info(
      { ticketId: session.ticketIdentifier, sessionId: session.sessionId, worktree: session.worktreePath },
      'Resuming Claude Code session'
    );

    // sessionId is guaranteed non-null by the check above
    const sessionId = session.sessionId;

    return new Promise((resolve, reject) => {
      let output = '';
      const timeoutMs = this.config.timeoutMs!;

      // Build args for resume mode
      const baseArgs: string[] = [
        '--resume', sessionId,               // Resume existing session
        '--dangerously-skip-permissions',    // Auto-approve all tool usage
        '--output-format', 'stream-json',    // Streaming JSON for real-time output
        '--verbose',                         // Required for stream-json
      ];
      const args: string[] = USE_NPX
        ? ['@anthropic-ai/claude-code', ...baseArgs]
        : baseArgs;

      logger.info(
        { ticketId: session.ticketIdentifier, sessionId, cwd: session.worktreePath },
        'Spawning Claude Code for session resume'
      );

      const childProcess = spawn(
        CLAUDE_PATH,
        args,
        {
          cwd: session.worktreePath,
          env: {
            ...process.env,
            CLAUDE_FLOW_NON_INTERACTIVE: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'] as const,
        }
      );

      const processId = `resume-${session.ticketIdentifier}-${Date.now()}`;
      const processEntry = { process: childProcess, ticketId: session.ticketIdentifier, recentOutput: [] as string[], startedAt: new Date() };
      this.runningProcesses.set(processId, processEntry);

      const timeout = setTimeout(() => {
        logger.warn({ ticketId: session.ticketIdentifier }, 'Claude Code resume timed out');
        this.killProcess(processId);
        reject(new AgentTimeoutError('code-executor', session.ticketIdentifier, timeoutMs));
      }, timeoutMs);

      childProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        this.appendRecentOutput(processEntry, text, processId);
        logger.debug({ ticketId: session.ticketIdentifier, bytes: text.length }, 'Claude Code resume output');
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        this.appendRecentOutput(processEntry, text, processId);
        logger.warn({ ticketId: session.ticketIdentifier, stderr: text.slice(0, 200) }, 'Claude Code resume stderr');
      });

      childProcess.on('close', (code: number | null) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(processId);
        this.clearJsonBuffer(processId);

        const result = this.parseOutput(output, code, session.ticketIdentifier);
        resolve(result);
      });

      childProcess.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.runningProcesses.delete(processId);
        this.clearJsonBuffer(processId);
        reject(new AgentExecutionError(
          'code-executor',
          session.ticketIdentifier,
          `Resume process error: ${error.message}`,
          true,
          error
        ));
      });
    });
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
                  // Extract useful context based on tool type
                  if (block.name === 'Read' && input.file_path) {
                    const filePath = String(input.file_path);
                    context = ` → ${filePath.split('/').slice(-2).join('/')}`;
                  } else if (block.name === 'Write' && input.file_path) {
                    const filePath = String(input.file_path);
                    context = ` → ${filePath.split('/').slice(-2).join('/')}`;
                  } else if (block.name === 'Edit' && input.file_path) {
                    const filePath = String(input.file_path);
                    context = ` → ${filePath.split('/').slice(-2).join('/')}`;
                  } else if (block.name === 'Bash' && input.command) {
                    const cmd = String(input.command).slice(0, 40);
                    context = ` → ${cmd}${String(input.command).length > 40 ? '...' : ''}`;
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
            // Clean up result text
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

export const codeExecutorAgent = new CodeExecutorAgent();
