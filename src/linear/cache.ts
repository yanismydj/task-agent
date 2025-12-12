import { getDatabase } from '../queue/database.js';
import { createChildLogger } from '../utils/logger.js';
import type { TicketInfo, CommentInfo } from './types.js';

const logger = createChildLogger({ module: 'linear-cache' });

/**
 * Cache manager for Linear data
 * Stores tickets, comments, and workflow states locally to reduce API calls
 */
export class LinearCache {
  /**
   * Upsert a ticket into the cache
   */
  upsertTicket(ticket: TicketInfo): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO linear_tickets_cache (
        id, identifier, title, description, priority,
        state_id, state_name, state_type,
        assignee_id, assignee_name, labels, project_id,
        created_at, updated_at, cached_at, url
      ) VALUES (
        @id, @identifier, @title, @description, @priority,
        @stateId, @stateName, @stateType,
        @assigneeId, @assigneeName, @labels, @projectId,
        @createdAt, @updatedAt, datetime('now'), @url
      )
      ON CONFLICT(id) DO UPDATE SET
        identifier = @identifier,
        title = @title,
        description = @description,
        priority = @priority,
        state_id = @stateId,
        state_name = @stateName,
        state_type = @stateType,
        assignee_id = @assigneeId,
        assignee_name = @assigneeName,
        labels = @labels,
        project_id = @projectId,
        updated_at = @updatedAt,
        cached_at = datetime('now'),
        url = @url
    `);

    stmt.run({
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description || null,
      priority: ticket.priority,
      stateId: ticket.state?.id || null,
      stateName: ticket.state?.name || null,
      stateType: ticket.state?.type || null,
      assigneeId: ticket.assignee?.id || null,
      assigneeName: ticket.assignee?.name || null,
      labels: JSON.stringify(ticket.labels || []),
      projectId: null, // TicketInfo doesn't have projectId yet
      createdAt: ticket.createdAt instanceof Date ? ticket.createdAt.toISOString() : ticket.createdAt,
      updatedAt: ticket.updatedAt instanceof Date ? ticket.updatedAt.toISOString() : ticket.updatedAt,
      url: ticket.url || null,
    });

    logger.debug({ ticketId: ticket.identifier }, 'Cached ticket');
  }

  /**
   * Upsert multiple tickets into the cache
   */
  upsertTickets(tickets: TicketInfo[]): void {
    const db = getDatabase();
    const transaction = db.transaction(() => {
      for (const ticket of tickets) {
        this.upsertTicket(ticket);
      }
    });
    transaction();
    logger.debug({ count: tickets.length }, 'Cached tickets batch');
  }

  /**
   * Get a ticket from the cache by ID or identifier
   */
  getTicket(idOrIdentifier: string): TicketInfo | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM linear_tickets_cache
      WHERE id = ? OR identifier = ?
    `);
    const row = stmt.get(idOrIdentifier, idOrIdentifier) as CachedTicketRow | undefined;

    if (!row) return null;

    return this.rowToTicket(row);
  }

  /**
   * Get all cached tickets matching criteria
   */
  getTickets(options?: { stateType?: string; hasLabel?: string }): TicketInfo[] {
    const db = getDatabase();
    let sql = 'SELECT * FROM linear_tickets_cache WHERE 1=1';
    const params: string[] = [];

    if (options?.stateType) {
      sql += ' AND state_type = ?';
      params.push(options.stateType);
    }

    if (options?.hasLabel) {
      sql += ' AND labels LIKE ?';
      params.push(`%"${options.hasLabel}"%`);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as CachedTicketRow[];

    return rows.map(row => this.rowToTicket(row));
  }

  /**
   * Delete a ticket from the cache (also deletes associated comments due to CASCADE)
   */
  deleteTicket(idOrIdentifier: string): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      DELETE FROM linear_tickets_cache
      WHERE id = ? OR identifier = ?
    `);
    stmt.run(idOrIdentifier, idOrIdentifier);
    logger.debug({ ticketId: idOrIdentifier }, 'Deleted ticket from cache');
  }

  /**
   * Upsert a comment into the cache
   */
  upsertComment(ticketId: string, comment: CommentInfo): void {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO linear_comments_cache (
        id, ticket_id, body, user_id, user_name, user_is_bot,
        created_at, updated_at, cached_at
      ) VALUES (
        @id, @ticketId, @body, @userId, @userName, @userIsBot,
        @createdAt, @updatedAt, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        body = @body,
        user_id = @userId,
        user_name = @userName,
        user_is_bot = @userIsBot,
        updated_at = @updatedAt,
        cached_at = datetime('now')
    `);

    stmt.run({
      id: comment.id,
      ticketId,
      body: comment.body,
      userId: comment.user?.id || null,
      userName: comment.user?.name || null,
      userIsBot: comment.user?.isBot ? 1 : 0,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
    });

    logger.debug({ commentId: comment.id, ticketId }, 'Cached comment');
  }

  /**
   * Upsert multiple comments for a ticket
   */
  upsertComments(ticketId: string, comments: CommentInfo[]): void {
    const db = getDatabase();
    const transaction = db.transaction(() => {
      for (const comment of comments) {
        this.upsertComment(ticketId, comment);
      }
    });
    transaction();
    logger.debug({ ticketId, count: comments.length }, 'Cached comments batch');
  }

  /**
   * Get all comments for a ticket from the cache
   */
  getComments(ticketId: string): CommentInfo[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT * FROM linear_comments_cache
      WHERE ticket_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(ticketId) as CachedCommentRow[];

    return rows.map(row => this.rowToComment(row));
  }

  /**
   * Check if we have comments cached for a ticket
   */
  hasComments(ticketId: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM linear_comments_cache
      WHERE ticket_id = ?
    `);
    const row = stmt.get(ticketId) as { count: number };
    return row.count > 0;
  }

  /**
   * Delete a comment from the cache
   */
  deleteComment(commentId: string): void {
    const db = getDatabase();
    const stmt = db.prepare('DELETE FROM linear_comments_cache WHERE id = ?');
    stmt.run(commentId);
  }

  /**
   * Cache workflow states for a team
   */
  cacheWorkflowStates(teamId: string, states: Array<{ id: string; name: string; type: string }>): void {
    const db = getDatabase();
    const transaction = db.transaction(() => {
      // Clear old states for this team
      db.prepare('DELETE FROM linear_workflow_states_cache WHERE team_id = ?').run(teamId);

      // Insert new states
      const stmt = db.prepare(`
        INSERT INTO linear_workflow_states_cache (id, name, type, team_id, cached_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `);

      for (const state of states) {
        stmt.run(state.id, state.name, state.type, teamId);
      }
    });
    transaction();
    logger.info({ teamId, count: states.length }, 'Cached workflow states');
  }

  /**
   * Get cached workflow states for a team
   */
  getWorkflowStates(teamId: string): Array<{ id: string; name: string; type: string }> {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT id, name, type FROM linear_workflow_states_cache
      WHERE team_id = ?
    `);
    return stmt.all(teamId) as Array<{ id: string; name: string; type: string }>;
  }

  /**
   * Check if workflow states are cached for a team
   */
  hasWorkflowStates(teamId: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM linear_workflow_states_cache
      WHERE team_id = ?
    `);
    const row = stmt.get(teamId) as { count: number };
    return row.count > 0;
  }

  /**
   * Get cache age for a ticket (in seconds)
   */
  getTicketCacheAge(idOrIdentifier: string): number | null {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT (julianday('now') - julianday(cached_at)) * 86400 as age_seconds
      FROM linear_tickets_cache
      WHERE id = ? OR identifier = ?
    `);
    const row = stmt.get(idOrIdentifier, idOrIdentifier) as { age_seconds: number } | undefined;
    return row?.age_seconds ?? null;
  }

  /**
   * Clear all cached data
   */
  clearAll(): void {
    const db = getDatabase();
    db.exec('DELETE FROM linear_comments_cache');
    db.exec('DELETE FROM linear_tickets_cache');
    db.exec('DELETE FROM linear_workflow_states_cache');
    logger.info('Cleared all Linear cache');
  }

  private rowToTicket(row: CachedTicketRow): TicketInfo {
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      description: row.description || null,
      priority: row.priority,
      state: row.state_id ? {
        id: row.state_id,
        name: row.state_name || '',
        type: row.state_type || '',
      } : { id: '', name: 'Unknown', type: 'unstarted' },
      assignee: row.assignee_id ? {
        id: row.assignee_id,
        name: row.assignee_name || '',
      } : null,
      labels: row.labels ? JSON.parse(row.labels) : [],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      url: row.url || '',
    };
  }

  private rowToComment(row: CachedCommentRow): CommentInfo {
    return {
      id: row.id,
      body: row.body,
      user: row.user_id ? {
        id: row.user_id,
        name: row.user_name || '',
        isBot: row.user_is_bot === 1,
      } : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

interface CachedTicketRow {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state_id: string | null;
  state_name: string | null;
  state_type: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  labels: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  cached_at: string;
  url: string | null;
}

interface CachedCommentRow {
  id: string;
  ticket_id: string;
  body: string;
  user_id: string | null;
  user_name: string | null;
  user_is_bot: number;
  created_at: string;
  updated_at: string;
  cached_at: string;
}

export const linearCache = new LinearCache();
