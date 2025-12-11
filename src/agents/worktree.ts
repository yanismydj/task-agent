import { spawn } from 'node:child_process';
import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'worktree-manager' });

const WORKTREE_DIR = '.task-agent/worktrees';

export class WorktreeManager {
  private baseDir: string;
  private worktreeBaseDir: string;

  constructor() {
    this.baseDir = config.agents.workDir;
    this.worktreeBaseDir = join(this.baseDir, WORKTREE_DIR);
  }

  async create(ticketIdentifier: string): Promise<{ path: string; branch: string }> {
    const sanitizedId = ticketIdentifier.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const branchName = `task-agent/${sanitizedId}`;
    const worktreePath = join(this.worktreeBaseDir, sanitizedId);

    logger.info({ ticketIdentifier, branchName, worktreePath }, 'Creating worktree');

    await mkdir(this.worktreeBaseDir, { recursive: true });

    const exists = await this.exists(worktreePath);
    if (exists) {
      logger.warn({ worktreePath }, 'Worktree already exists, removing first');
      await this.remove(ticketIdentifier);
    }

    await this.execGit(['worktree', 'add', worktreePath, '-b', branchName], this.baseDir);

    logger.info({ ticketIdentifier, worktreePath }, 'Worktree created');

    return { path: worktreePath, branch: branchName };
  }

  async remove(ticketIdentifier: string): Promise<void> {
    const sanitizedId = ticketIdentifier.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const worktreePath = join(this.worktreeBaseDir, sanitizedId);

    logger.info({ ticketIdentifier, worktreePath }, 'Removing worktree');

    try {
      await this.execGit(['worktree', 'remove', worktreePath, '--force'], this.baseDir);
    } catch {
      logger.warn({ worktreePath }, 'Failed to remove worktree via git, trying manual removal');
      await rm(worktreePath, { recursive: true, force: true });
      await this.execGit(['worktree', 'prune'], this.baseDir);
    }

    const branchName = `task-agent/${sanitizedId}`;
    try {
      await this.execGit(['branch', '-D', branchName], this.baseDir);
    } catch {
      logger.debug({ branchName }, 'Branch may not exist or already deleted');
    }

    logger.info({ ticketIdentifier }, 'Worktree removed');
  }

  async exists(worktreePath: string): Promise<boolean> {
    try {
      await access(worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  async listWorktrees(): Promise<string[]> {
    try {
      const output = await this.execGit(['worktree', 'list', '--porcelain'], this.baseDir);
      const worktrees: string[] = [];
      const lines = output.split('\n');

      for (const line of lines) {
        if (line.startsWith('worktree ') && line.includes(WORKTREE_DIR)) {
          worktrees.push(line.replace('worktree ', ''));
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  private execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Git command failed: ${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }
}

export const worktreeManager = new WorktreeManager();
