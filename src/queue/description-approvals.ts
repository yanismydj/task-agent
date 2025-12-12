import { getDatabase } from './database.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'description-approvals' });

export interface PendingApproval {
  id: number;
  ticketId: string;
  ticketIdentifier: string;
  commentId: string;
  proposedDescription: string;
  originalDescription: string | null;
  createdAt: Date;
  status: 'pending' | 'approved' | 'rejected';
}

export class DescriptionApprovalManager {
  /**
   * Create a new pending approval for a description rewrite
   */
  createPending(
    ticketId: string,
    ticketIdentifier: string,
    commentId: string,
    proposedDescription: string,
    originalDescription: string | null
  ): number {
    const db = getDatabase();

    // First, cancel any existing pending approvals for this ticket
    db.prepare(`
      UPDATE pending_description_approvals
      SET status = 'rejected'
      WHERE ticket_id = ? AND status = 'pending'
    `).run(ticketId);

    const result = db.prepare(`
      INSERT INTO pending_description_approvals
        (ticket_id, ticket_identifier, comment_id, proposed_description, original_description, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(ticketId, ticketIdentifier, commentId, proposedDescription, originalDescription);

    logger.info(
      { ticketId: ticketIdentifier, commentId, approvalId: result.lastInsertRowid },
      'Created pending description approval'
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Get pending approval by comment ID (used when processing emoji reactions)
   */
  getPendingByCommentId(commentId: string): PendingApproval | null {
    const db = getDatabase();

    const row = db.prepare(`
      SELECT * FROM pending_description_approvals
      WHERE comment_id = ? AND status = 'pending'
    `).get(commentId) as any;

    if (!row) {
      return null;
    }

    return this.mapRow(row);
  }

  /**
   * Get pending approval by ticket ID
   */
  getPendingByTicketId(ticketId: string): PendingApproval | null {
    const db = getDatabase();

    const row = db.prepare(`
      SELECT * FROM pending_description_approvals
      WHERE ticket_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(ticketId) as any;

    if (!row) {
      return null;
    }

    return this.mapRow(row);
  }

  /**
   * Mark an approval as approved
   */
  approve(commentId: string): PendingApproval | null {
    const db = getDatabase();

    const approval = this.getPendingByCommentId(commentId);
    if (!approval) {
      return null;
    }

    db.prepare(`
      UPDATE pending_description_approvals
      SET status = 'approved'
      WHERE comment_id = ?
    `).run(commentId);

    logger.info(
      { ticketId: approval.ticketIdentifier, commentId, approvalId: approval.id },
      'Approved description rewrite'
    );

    return { ...approval, status: 'approved' };
  }

  /**
   * Mark an approval as rejected
   */
  reject(commentId: string): PendingApproval | null {
    const db = getDatabase();

    const approval = this.getPendingByCommentId(commentId);
    if (!approval) {
      return null;
    }

    db.prepare(`
      UPDATE pending_description_approvals
      SET status = 'rejected'
      WHERE comment_id = ?
    `).run(commentId);

    logger.info(
      { ticketId: approval.ticketIdentifier, commentId, approvalId: approval.id },
      'Rejected description rewrite'
    );

    return { ...approval, status: 'rejected' };
  }

  /**
   * Clean up old approvals (older than 7 days)
   */
  cleanupOld(daysOld = 7): number {
    const db = getDatabase();

    const result = db.prepare(`
      DELETE FROM pending_description_approvals
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(daysOld);

    if (result.changes > 0) {
      logger.info({ deletedCount: result.changes, daysOld }, 'Cleaned up old pending approvals');
    }

    return result.changes;
  }

  private mapRow(row: any): PendingApproval {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      ticketIdentifier: row.ticket_identifier,
      commentId: row.comment_id,
      proposedDescription: row.proposed_description,
      originalDescription: row.original_description,
      createdAt: new Date(row.created_at),
      status: row.status,
    };
  }
}

export const descriptionApprovalManager = new DescriptionApprovalManager();
