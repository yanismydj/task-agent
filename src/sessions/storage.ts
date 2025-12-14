import { getDatabase } from '../queue/database.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'session-storage' });

export type SessionStatus = 'active' | 'interrupted' | 'completed' | 'failed';

export interface SessionRecord {
  id: number;
  sessionId: string | null;
  ticketId: string;
  ticketIdentifier: string;
  queueItemId: number | null;
  prompt: string;
  worktreePath: string;
  branchName: string;
  agentSessionId: string | null;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  interruptedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  resumeCount: number;
}

export interface CreateSessionParams {
  ticketId: string;
  ticketIdentifier: string;
  queueItemId?: number;
  prompt: string;
  worktreePath: string;
  branchName: string;
  agentSessionId?: string;
}

interface SessionRow {
  id: number;
  session_id: string | null;
  ticket_id: string;
  ticket_identifier: string;
  queue_item_id: number | null;
  prompt: string;
  worktree_path: string;
  branch_name: string;
  agent_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  interrupted_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  resume_count: number;
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ticketId: row.ticket_id,
    ticketIdentifier: row.ticket_identifier,
    queueItemId: row.queue_item_id,
    prompt: row.prompt,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    agentSessionId: row.agent_session_id,
    status: row.status as SessionStatus,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    interruptedAt: row.interrupted_at ? new Date(row.interrupted_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    errorMessage: row.error_message,
    resumeCount: row.resume_count,
  };
}

export class SessionStorage {
  /**
   * Create a new session record
   */
  create(params: CreateSessionParams): SessionRecord {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO claude_code_sessions (
        ticket_id, ticket_identifier, queue_item_id, prompt,
        worktree_path, branch_name, agent_session_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `);

    const result = stmt.run(
      params.ticketId,
      params.ticketIdentifier,
      params.queueItemId ?? null,
      params.prompt,
      params.worktreePath,
      params.branchName,
      params.agentSessionId ?? null
    );

    const session = this.getById(Number(result.lastInsertRowid));
    if (!session) {
      throw new Error('Failed to create session record');
    }

    logger.info(
      { sessionId: session.id, ticketIdentifier: params.ticketIdentifier },
      'Created session record'
    );

    return session;
  }

  /**
   * Update the Claude Code session ID (captured from stream-json output)
   */
  updateSessionId(id: number, sessionId: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE claude_code_sessions
      SET session_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(sessionId, id);
    logger.debug({ id, sessionId }, 'Updated session ID');
  }

  /**
   * Mark a session as interrupted (daemon died or process killed)
   */
  markInterrupted(id: number, errorMessage?: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE claude_code_sessions
      SET status = 'interrupted',
          interrupted_at = datetime('now'),
          updated_at = datetime('now'),
          error_message = COALESCE(?, error_message)
      WHERE id = ?
    `);
    stmt.run(errorMessage ?? null, id);
    logger.info({ id }, 'Marked session as interrupted');
  }

  /**
   * Mark a session as resumed and increment resume count
   */
  markResumed(id: number): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE claude_code_sessions
      SET status = 'active',
          resume_count = resume_count + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(id);
    logger.info({ id }, 'Marked session as resumed');
  }

  /**
   * Mark a session as completed successfully
   */
  markCompleted(id: number): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE claude_code_sessions
      SET status = 'completed',
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(id);
    logger.info({ id }, 'Marked session as completed');
  }

  /**
   * Mark a session as failed
   */
  markFailed(id: number, errorMessage: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      UPDATE claude_code_sessions
      SET status = 'failed',
          completed_at = datetime('now'),
          updated_at = datetime('now'),
          error_message = ?
      WHERE id = ?
    `);
    stmt.run(errorMessage, id);
    logger.info({ id, errorMessage }, 'Marked session as failed');
  }

  /**
   * Get a session by its database ID
   */
  getById(id: number): SessionRecord | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM claude_code_sessions WHERE id = ?');
    const row = stmt.get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Get a session by Claude Code's session ID
   */
  getBySessionId(sessionId: string): SessionRecord | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM claude_code_sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Get the most recent session for a ticket (any status)
   */
  getByTicket(ticketId: string): SessionRecord | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM claude_code_sessions
      WHERE ticket_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(ticketId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Get the active session for a ticket (if any)
   */
  getActiveByTicket(ticketId: string): SessionRecord | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM claude_code_sessions
      WHERE ticket_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(ticketId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * List sessions by status
   */
  listByStatus(status: SessionStatus, limit = 50): SessionRecord[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM claude_code_sessions
      WHERE status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(status, limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * List all resumable sessions (interrupted or stale active)
   */
  listResumable(limit = 50): SessionRecord[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM claude_code_sessions
      WHERE status IN ('interrupted', 'active')
        AND session_id IS NOT NULL
      ORDER BY
        CASE WHEN status = 'interrupted' THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * List all sessions (optionally filtered by ticket)
   */
  listAll(ticketId?: string, limit = 50): SessionRecord[] {
    const db = getDatabase();

    if (ticketId) {
      const stmt = db.prepare(`
        SELECT * FROM claude_code_sessions
        WHERE ticket_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      const rows = stmt.all(ticketId, limit) as SessionRow[];
      return rows.map(rowToSession);
    }

    const stmt = db.prepare(`
      SELECT * FROM claude_code_sessions
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Delete a session by ID
   */
  delete(id: number): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM claude_code_sessions WHERE id = ?');
    stmt.run(id);
    logger.info({ id }, 'Deleted session');
  }

  /**
   * Clean up old sessions
   */
  cleanup(olderThanDays: number, statuses: SessionStatus[]): number {
    const db = getDatabase();
    const placeholders = statuses.map(() => '?').join(', ');
    const stmt = db.prepare(`
      DELETE FROM claude_code_sessions
      WHERE status IN (${placeholders})
        AND updated_at < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(...statuses, olderThanDays);
    logger.info({ deletedCount: result.changes, olderThanDays, statuses }, 'Cleaned up old sessions');
    return result.changes;
  }

  /**
   * Detect and mark interrupted sessions on startup
   * Called when daemon starts to find sessions that were active when it died
   */
  detectInterruptedSessions(staleThresholdMinutes = 60): number {
    const db = getDatabase();

    // Mark sessions that were 'active' but haven't been updated recently
    // These are likely from a crashed daemon
    const stmt = db.prepare(`
      UPDATE claude_code_sessions
      SET status = 'interrupted',
          interrupted_at = datetime('now'),
          error_message = 'Daemon shutdown or crash detected'
      WHERE status = 'active'
        AND updated_at < datetime('now', '-' || ? || ' minutes')
    `);

    const result = stmt.run(staleThresholdMinutes);

    if (result.changes > 0) {
      logger.warn(
        { count: result.changes, staleThresholdMinutes },
        'Detected interrupted sessions from previous run'
      );
    }

    return result.changes;
  }
}

export const sessionStorage = new SessionStorage();
