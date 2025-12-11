import Database from 'better-sqlite3';
import path from 'node:path';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'queue-database' });

let db: Database.Database | null = null;

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string[]> = {
  1: [
    // Linear ticket processing queue
    // Handles: evaluation, refinement, approval checking, prompt generation
    `CREATE TABLE IF NOT EXISTS linear_ticket_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      ticket_identifier TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 3,
      readiness_score INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      error_message TEXT,
      input_data TEXT,
      output_data TEXT,
      UNIQUE(ticket_id, task_type, status)
    )`,

    // Claude Code execution queue
    // Handles: code execution tasks that spawn Claude CLI
    `CREATE TABLE IF NOT EXISTS claude_code_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      ticket_identifier TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 3,
      readiness_score INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      error_message TEXT,
      prompt TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      pr_url TEXT,
      agent_session_id TEXT,
      UNIQUE(ticket_id, status)
    )`,

    // Schema version tracking
    `CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )`,

    // Indexes for efficient querying
    `CREATE INDEX IF NOT EXISTS idx_linear_queue_status_priority
     ON linear_ticket_queue(status, priority ASC, readiness_score DESC, created_at ASC)`,

    `CREATE INDEX IF NOT EXISTS idx_linear_queue_ticket
     ON linear_ticket_queue(ticket_id, task_type)`,

    `CREATE INDEX IF NOT EXISTS idx_claude_queue_status_priority
     ON claude_code_queue(status, priority ASC, readiness_score DESC, created_at ASC)`,

    `CREATE INDEX IF NOT EXISTS idx_claude_queue_ticket
     ON claude_code_queue(ticket_id)`,

    `INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION})`,
  ],
};

export function initDatabase(dbPath?: string): Database.Database {
  if (db) {
    return db;
  }

  const resolvedPath = dbPath || path.join(process.cwd(), '.task-agent-queue.db');

  logger.info({ dbPath: resolvedPath }, 'Initializing task queue database');

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  logger.info('Task queue database initialized');
  return db;
}

function runMigrations(database: Database.Database): void {
  const currentVersion = getCurrentSchemaVersion(database);

  if (currentVersion >= SCHEMA_VERSION) {
    logger.debug({ currentVersion, targetVersion: SCHEMA_VERSION }, 'Schema up to date');
    return;
  }

  logger.info({ currentVersion, targetVersion: SCHEMA_VERSION }, 'Running migrations');

  for (let version = currentVersion + 1; version <= SCHEMA_VERSION; version++) {
    const statements = MIGRATIONS[version];
    if (!statements) {
      throw new Error(`Missing migration for version ${version}`);
    }

    const transaction = database.transaction(() => {
      for (const sql of statements) {
        database.exec(sql);
      }
    });

    transaction();
    logger.info({ version }, 'Applied migration');
  }
}

function getCurrentSchemaVersion(database: Database.Database): number {
  try {
    const row = database
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    return row?.version || 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

// Task status enum
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

// Linear ticket task types
export type LinearTaskType =
  | 'evaluate'        // Run readiness scorer
  | 'refine'          // Run ticket refiner
  | 'check_response'  // Check for human response
  | 'generate_prompt' // Generate execution prompt
  | 'sync_state';     // Sync state to Linear

// Priority levels (matching Linear: 1=urgent, 2=high, 3=medium, 4=low, 0=no priority)
export type Priority = 0 | 1 | 2 | 3 | 4;

export const PRIORITY_LABELS: Record<Priority, string> = {
  0: 'No Priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};
