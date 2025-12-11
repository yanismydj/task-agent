import { spawn, ChildProcess } from 'node:child_process';
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config.js';
import type { AgentState, AgentResult, WorkAssignment } from './types.js';

const logger = createChildLogger({ module: 'agent-worker' });

export class AgentWorker {
  private state: AgentState;
  private process: ChildProcess | null = null;
  private output: string = '';
  private onComplete: ((result: AgentResult) => void) | null = null;

  constructor(id: string) {
    this.state = {
      id,
      status: 'idle',
      ticketId: null,
      ticketIdentifier: null,
      worktreePath: null,
      branchName: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      lastError: null,
      processId: null,
    };
  }

  get id(): string {
    return this.state.id;
  }

  get status(): AgentState['status'] {
    return this.state.status;
  }

  get ticketIdentifier(): string | null {
    return this.state.ticketIdentifier;
  }

  get retryCount(): number {
    return this.state.retryCount;
  }

  isIdle(): boolean {
    return this.state.status === 'idle';
  }

  getState(): Readonly<AgentState> {
    return { ...this.state };
  }

  assign(assignment: WorkAssignment, worktreePath: string, branchName: string): void {
    this.state.status = 'assigned';
    this.state.ticketId = assignment.ticketId;
    this.state.ticketIdentifier = assignment.ticketIdentifier;
    this.state.worktreePath = worktreePath;
    this.state.branchName = branchName;
    this.output = '';

    logger.info(
      {
        agentId: this.state.id,
        ticketId: assignment.ticketIdentifier,
      },
      'Agent assigned to ticket'
    );
  }

  async start(onComplete: (result: AgentResult) => void): Promise<void> {
    if (this.state.status !== 'assigned') {
      throw new Error(`Cannot start agent in ${this.state.status} state`);
    }

    this.onComplete = onComplete;
    this.state.status = 'working';
    this.state.startedAt = new Date();

    const prompt = this.buildPrompt();

    logger.info(
      {
        agentId: this.state.id,
        ticketId: this.state.ticketIdentifier,
        worktree: this.state.worktreePath,
      },
      'Starting Claude Code agent'
    );

    try {
      this.process = spawn(
        'claude',
        [
          '--print',
          '--dangerously-skip-permissions',
          prompt,
        ],
        {
          cwd: this.state.worktreePath!,
          env: { ...process.env },
        }
      );

      this.state.processId = this.process.pid ?? null;

      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.output += text;
        logger.debug({ agentId: this.state.id, output: text.slice(0, 200) }, 'Agent output');
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        this.output += text;
        logger.warn({ agentId: this.state.id, stderr: text }, 'Agent stderr');
      });

      this.process.on('close', (code) => this.handleExit(code));
      this.process.on('error', (error) => this.handleError(error));

      const timeoutMs = config.agents.timeoutMinutes * 60 * 1000;
      setTimeout(() => {
        if (this.state.status === 'working') {
          logger.warn({ agentId: this.state.id }, 'Agent timed out');
          this.kill();
          this.handleError(new Error('Agent timed out'));
        }
      }, timeoutMs);
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  kill(): void {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  reset(): void {
    this.state = {
      id: this.state.id,
      status: 'idle',
      ticketId: null,
      ticketIdentifier: null,
      worktreePath: null,
      branchName: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      lastError: null,
      processId: null,
    };
    this.process = null;
    this.output = '';
    this.onComplete = null;
  }

  incrementRetry(): void {
    this.state.retryCount++;
    this.state.status = 'retrying';
  }

  private buildPrompt(): string {
    return `You are working on ticket ${this.state.ticketIdentifier}.

Your task is to implement the changes described in this ticket and create a draft pull request.

IMPORTANT INSTRUCTIONS:
1. Read and understand the codebase before making changes
2. Implement the minimal changes needed to address the ticket
3. Write tests if appropriate for the changes
4. Commit your changes with a clear message referencing the ticket
5. Create a draft pull request with:
   - Title: "${this.state.ticketIdentifier}: <brief description>"
   - Body: Summary of changes and link to the ticket
6. If you encounter blockers or questions, note them but continue with your best judgment

When done, output "TASK_COMPLETE" followed by the PR URL if created.
If you cannot complete the task, output "TASK_FAILED" followed by the reason.`;
  }

  private handleExit(code: number | null): void {
    this.state.completedAt = new Date();

    if (code === 0) {
      const prUrlMatch = this.output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      const prUrl = prUrlMatch?.[0];

      if (this.output.includes('TASK_COMPLETE')) {
        this.state.status = 'completed';
        logger.info({ agentId: this.state.id, prUrl }, 'Agent completed successfully');
        this.onComplete?.({ success: true, prUrl, output: this.output });
      } else if (this.output.includes('TASK_FAILED')) {
        this.state.status = 'failed';
        this.state.lastError = 'Task marked as failed by agent';
        logger.warn({ agentId: this.state.id }, 'Agent reported task failure');
        this.onComplete?.({ success: false, error: 'Task failed', output: this.output });
      } else {
        this.state.status = 'completed';
        logger.info({ agentId: this.state.id, prUrl }, 'Agent exited successfully');
        this.onComplete?.({ success: true, prUrl, output: this.output });
      }
    } else {
      this.state.status = 'failed';
      this.state.lastError = `Process exited with code ${code}`;
      logger.error({ agentId: this.state.id, code }, 'Agent process failed');
      this.onComplete?.({ success: false, error: `Exit code ${code}`, output: this.output });
    }
  }

  private handleError(error: Error): void {
    this.state.status = 'failed';
    this.state.lastError = error.message;
    this.state.completedAt = new Date();
    logger.error({ agentId: this.state.id, error: error.message }, 'Agent error');
    this.onComplete?.({ success: false, error: error.message, output: this.output });
  }
}
