import Database from 'better-sqlite3';
import { createChildLogger } from '../utils/logger.js';
import {
  getQueueDbPath,
  getLegacyQueueDbPath,
  migrateLegacyFile,
} from '../utils/paths.js';

const logger = createChildLogger({ module: 'queue-database' });

let db: Database.Database | null = null;

const SCHEMA_VERSION = 8;

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

    `INSERT OR IGNORE INTO schema_version (version) VALUES (1)`,
  ],

  // Migration 2: Remove problematic UNIQUE constraints
  // The old constraint UNIQUE(ticket_id, task_type, status) caused issues when:
  // - Completing a task (can't have multiple completed tasks for same ticket/type)
  // - Retrying a failed task (might conflict with new pending tasks)
  // SQLite doesn't support DROP CONSTRAINT, so we recreate the tables
  2: [
    // Recreate linear_ticket_queue without the problematic UNIQUE constraint
    `CREATE TABLE IF NOT EXISTS linear_ticket_queue_new (
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
      output_data TEXT
    )`,

    `INSERT INTO linear_ticket_queue_new SELECT * FROM linear_ticket_queue`,

    `DROP TABLE linear_ticket_queue`,

    `ALTER TABLE linear_ticket_queue_new RENAME TO linear_ticket_queue`,

    // Recreate indexes
    `CREATE INDEX IF NOT EXISTS idx_linear_queue_status_priority
     ON linear_ticket_queue(status, priority ASC, readiness_score DESC, created_at ASC)`,

    `CREATE INDEX IF NOT EXISTS idx_linear_queue_ticket
     ON linear_ticket_queue(ticket_id, task_type)`,

    // Recreate claude_code_queue without UNIQUE constraint
    `CREATE TABLE IF NOT EXISTS claude_code_queue_new (
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
      agent_session_id TEXT
    )`,

    `INSERT INTO claude_code_queue_new SELECT * FROM claude_code_queue`,

    `DROP TABLE claude_code_queue`,

    `ALTER TABLE claude_code_queue_new RENAME TO claude_code_queue`,

    // Recreate indexes
    `CREATE INDEX IF NOT EXISTS idx_claude_queue_status_priority
     ON claude_code_queue(status, priority ASC, readiness_score DESC, created_at ASC)`,

    `CREATE INDEX IF NOT EXISTS idx_claude_queue_ticket
     ON claude_code_queue(ticket_id)`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (2)`,
  ],

  // Migration 3: Add Linear data cache tables
  // Cache ticket and comment data locally to reduce API calls
  3: [
    // Cached Linear tickets - updated via webhooks and periodic polling
    `CREATE TABLE IF NOT EXISTS linear_tickets_cache (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      state_id TEXT,
      state_name TEXT,
      state_type TEXT,
      assignee_id TEXT,
      assignee_name TEXT,
      labels TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      url TEXT
    )`,

    // Cached Linear comments - updated via webhooks
    `CREATE TABLE IF NOT EXISTS linear_comments_cache (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      body TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      user_is_bot INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES linear_tickets_cache(id) ON DELETE CASCADE
    )`,

    // Cached workflow states - refreshed at startup
    `CREATE TABLE IF NOT EXISTS linear_workflow_states_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      team_id TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    // Indexes for cache tables
    `CREATE INDEX IF NOT EXISTS idx_tickets_cache_identifier
     ON linear_tickets_cache(identifier)`,

    `CREATE INDEX IF NOT EXISTS idx_tickets_cache_state
     ON linear_tickets_cache(state_type, state_name)`,

    `CREATE INDEX IF NOT EXISTS idx_comments_cache_ticket
     ON linear_comments_cache(ticket_id, created_at)`,

    `CREATE INDEX IF NOT EXISTS idx_workflow_states_team
     ON linear_workflow_states_cache(team_id, type)`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (3)`,
  ],

  // Migration 4: Add webhook delivery tracking for idempotency
  // Linear retries webhooks if we don't respond within 5 seconds
  // Track delivery IDs to prevent duplicate processing
  4: [
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed INTEGER NOT NULL DEFAULT 0
    )`,

    // Index for cleanup of old deliveries
    `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
     ON webhook_deliveries(received_at)`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (4)`,
  ],

  // Migration 5: Add pending description approvals table
  // Tracks description rewrites awaiting user approval via emoji reactions
  5: [
    `CREATE TABLE IF NOT EXISTS pending_description_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL UNIQUE,
      ticket_identifier TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      proposed_description TEXT NOT NULL,
      original_description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending'
    )`,

    `CREATE INDEX IF NOT EXISTS idx_pending_approvals_ticket
     ON pending_description_approvals(ticket_id)`,

    `CREATE INDEX IF NOT EXISTS idx_pending_approvals_comment
     ON pending_description_approvals(comment_id)`,

    `CREATE INDEX IF NOT EXISTS idx_pending_approvals_status
     ON pending_description_approvals(status, created_at)`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (5)`,
  ],

  // Migration 6: Add labels cache table
  // Cache label id -> name mappings to avoid extra API calls when mapping issues
  6: [
    `CREATE TABLE IF NOT EXISTS linear_labels_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      team_id TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE INDEX IF NOT EXISTS idx_labels_cache_team
     ON linear_labels_cache(team_id)`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (6)`,
  ],

  // Migration 7: Add Claude Code session persistence table
  // Track Claude Code sessions for manual resumption after interruptions
  7: [
    `CREATE TABLE IF NOT EXISTS claude_code_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE,
      ticket_id TEXT NOT NULL,
      ticket_identifier TEXT NOT NULL,
      queue_item_id INTEGER,
      prompt TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      agent_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      interrupted_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0
    )`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_status
     ON claude_code_sessions(status)`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_ticket
     ON claude_code_sessions(ticket_id)`,

    `CREATE INDEX IF NOT EXISTS idx_sessions_session_id
     ON claude_code_sessions(session_id)`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (7)`,
  ],

  // Migration 8: Add PR creation retry tracking
  // Track retry attempts specifically for PR creation validation
  8: [
    `ALTER TABLE claude_code_queue ADD COLUMN pr_creation_retry_count INTEGER NOT NULL DEFAULT 0`,

    `INSERT OR REPLACE INTO schema_version (version) VALUES (8)`,
  ],
};

export function initDatabase(dbPath?: string): Database.Database {
  if (db) {
    return db;
  }

  // Use new .taskagent/ path, falling back to provided path
  const resolvedPath = dbPath || getQueueDbPath();

  // Migrate from legacy path if needed
  const legacyPath = getLegacyQueueDbPath();
  if (migrateLegacyFile(legacyPath, resolvedPath)) {
    logger.info({ from: legacyPath, to: resolvedPath }, 'Migrated database from legacy path');
    // Also migrate WAL files if they exist
    migrateLegacyFile(legacyPath + '-wal', resolvedPath + '-wal');
    migrateLegacyFile(legacyPath + '-shm', resolvedPath + '-shm');
  }

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
  | 'refine'          // Run ticket refiner (also: @taskAgent clarify)
  | 'consolidate'     // Consolidate discussion into description (@taskAgent rewrite)
  | 'execute'         // Start Claude Code directly (@taskAgent work)
  | 'plan'            // Enter planning mode with Claude Code (@taskAgent plan)
  | 'consolidate_plan' // Consolidate planning Q&A into implementation plan
  | 'check_response'  // Check for human response (deprecated)
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

// Webhook delivery idempotency helpers

/**
 * Check if a webhook delivery has already been processed
 */
export function isWebhookDeliveryProcessed(deliveryId: string): boolean {
  const database = getDatabase();
  const stmt = database.prepare(
    'SELECT processed FROM webhook_deliveries WHERE delivery_id = ?'
  );
  const row = stmt.get(deliveryId) as { processed: number } | undefined;
  return row?.processed === 1;
}

/**
 * Record a webhook delivery as received (but not yet processed)
 * Returns false if delivery was already recorded (duplicate)
 */
export function recordWebhookDelivery(deliveryId: string, eventType: string): boolean {
  const database = getDatabase();
  try {
    const stmt = database.prepare(
      'INSERT INTO webhook_deliveries (delivery_id, event_type) VALUES (?, ?)'
    );
    stmt.run(deliveryId, eventType);
    return true;
  } catch (error) {
    // UNIQUE constraint violation means duplicate
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return false;
    }
    throw error;
  }
}

/**
 * Mark a webhook delivery as fully processed
 */
export function markWebhookDeliveryProcessed(deliveryId: string): void {
  const database = getDatabase();
  const stmt = database.prepare(
    'UPDATE webhook_deliveries SET processed = 1 WHERE delivery_id = ?'
  );
  stmt.run(deliveryId);
}

/**
 * Clean up old webhook deliveries (older than 24 hours)
 * Call periodically to prevent table from growing indefinitely
 */
export function cleanupOldWebhookDeliveries(): number {
  const database = getDatabase();
  const stmt = database.prepare(
    "DELETE FROM webhook_deliveries WHERE received_at < datetime('now', '-24 hours')"
  );
  const result = stmt.run();
  return result.changes;
}
