import path from 'node:path';
import fs from 'node:fs';

/**
 * Centralized path management for TaskAgent internal files.
 * All internal files are stored in .taskagent/ to reduce root-level clutter.
 *
 * Directory structure:
 * .taskagent/
 *   queue.db          - SQLite task queue database
 *   repo-summary.json - Repository context summary
 *   token.json        - OAuth token storage
 *   worktrees/        - Git worktrees for parallel execution
 *   cache/            - Temporary cache files
 */

const TASKAGENT_DIR = '.taskagent';

/**
 * Get the root TaskAgent directory path
 * Creates the directory if it doesn't exist
 */
export function getTaskAgentDir(workDir: string = process.cwd()): string {
  const dir = path.join(workDir, TASKAGENT_DIR);
  ensureDir(dir);
  return dir;
}

/**
 * Get the queue database path
 * Default: .taskagent/queue.db
 */
export function getQueueDbPath(workDir: string = process.cwd()): string {
  return path.join(getTaskAgentDir(workDir), 'queue.db');
}

/**
 * Get the repository summary path
 * Default: .taskagent/repo-summary.json
 */
export function getRepoSummaryPath(workDir: string = process.cwd()): string {
  return path.join(getTaskAgentDir(workDir), 'repo-summary.json');
}

/**
 * Get the OAuth token storage path
 * Default: .taskagent/token.json
 */
export function getTokenPath(workDir: string = process.cwd()): string {
  return path.join(getTaskAgentDir(workDir), 'token.json');
}

/**
 * Get the worktrees directory path
 * Default: .taskagent/worktrees/
 */
export function getWorktreesDir(workDir: string = process.cwd()): string {
  const dir = path.join(getTaskAgentDir(workDir), 'worktrees');
  ensureDir(dir);
  return dir;
}

/**
 * Get the cache directory path
 * Default: .taskagent/cache/
 */
export function getCacheDir(workDir: string = process.cwd()): string {
  const dir = path.join(getTaskAgentDir(workDir), 'cache');
  ensureDir(dir);
  return dir;
}

/**
 * Ensure a directory exists, creating it if necessary
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Check if a legacy file exists and migrate it to the new location
 * Returns true if migration occurred
 */
export function migrateLegacyFile(
  legacyPath: string,
  newPath: string,
  options: { copy?: boolean } = {}
): boolean {
  if (fs.existsSync(legacyPath) && !fs.existsSync(newPath)) {
    // Ensure parent directory exists
    const parentDir = path.dirname(newPath);
    ensureDir(parentDir);

    if (options.copy) {
      fs.copyFileSync(legacyPath, newPath);
    } else {
      fs.renameSync(legacyPath, newPath);
    }
    return true;
  }
  return false;
}

/**
 * Get legacy database path (for migration)
 */
export function getLegacyQueueDbPath(workDir: string = process.cwd()): string {
  return path.join(workDir, '.task-agent-queue.db');
}

/**
 * Get legacy repo summary path (for migration)
 */
export function getLegacyRepoSummaryPath(workDir: string = process.cwd()): string {
  return path.join(workDir, '.task-agent-repo-summary.json');
}

/**
 * Get legacy token path (for migration)
 */
export function getLegacyTokenPath(workDir: string = process.cwd()): string {
  return path.join(workDir, '.task-agent-token.json');
}
