import Database from 'better-sqlite3';
import path from 'node:path';
import { createChildLogger } from '../../utils/logger.js';
import { getCacheDir } from '../../utils/paths.js';
import type { AgentType, AgentOutput } from './types.js';

const logger = createChildLogger({ module: 'agent-cache' });

const CACHE_FILE = 'agent-cache.db';

// Default TTLs by agent type (in milliseconds)
const DEFAULT_TTL: Record<AgentType, number> = {
  'readiness-scorer': 24 * 60 * 60 * 1000, // 24 hours
  'ticket-refiner': 0, // Never cache (always fresh)
  'prompt-generator': 60 * 60 * 1000, // 1 hour
  'code-executor': 0, // Never cache
  'planner': 0, // Never cache (planning is interactive)
  'plan-consolidator': 60 * 60 * 1000, // 1 hour
};

interface CacheEntry {
  key: string;
  agent_type: string;
  value: string;
  created_at: string;
  expires_at: string;
  ticket_id: string;
  ticket_updated_at: string;
}

export class AgentCache {
  private db: Database.Database;

  constructor() {
    // getCacheDir() ensures the directory exists
    const cacheDir = getCacheDir();
    const dbPath = path.join(cacheDir, CACHE_FILE);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.initTable();
    logger.info({ dbPath }, 'Agent cache initialized');
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_cache (
        key TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        ticket_updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_cache_type ON agent_cache(agent_type)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_cache_ticket ON agent_cache(ticket_id)
    `);
  }

  get<T>(
    key: string,
    ticketUpdatedAt: Date
  ): AgentOutput<T> | null {
    const entry = this.db
      .prepare('SELECT * FROM agent_cache WHERE key = ?')
      .get(key) as CacheEntry | undefined;

    if (!entry) {
      return null;
    }

    // Invalidate if ticket was updated after cache entry
    const cachedTicketUpdate = new Date(entry.ticket_updated_at);
    if (ticketUpdatedAt > cachedTicketUpdate) {
      this.invalidate(key);
      logger.debug({ key }, 'Cache invalidated: ticket updated');
      return null;
    }

    // Check expiration
    const expiresAt = new Date(entry.expires_at);
    if (expiresAt < new Date()) {
      this.invalidate(key);
      logger.debug({ key }, 'Cache invalidated: expired');
      return null;
    }

    try {
      const value = JSON.parse(entry.value) as AgentOutput<T>;
      logger.debug({ key, agentType: entry.agent_type }, 'Cache hit');
      return {
        ...value,
        metadata: {
          ...value.metadata,
          cached: true,
          modelUsed: value.metadata?.modelUsed ?? 'unknown',
          durationMs: 0, // Instant from cache
        },
      };
    } catch {
      this.invalidate(key);
      return null;
    }
  }

  set<T>(
    key: string,
    agentType: AgentType,
    value: AgentOutput<T>,
    ticketId: string,
    ticketUpdatedAt: Date,
    ttlMs?: number
  ): void {
    const effectiveTtl = ttlMs ?? DEFAULT_TTL[agentType];

    // Don't cache if TTL is 0
    if (effectiveTtl === 0) {
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + effectiveTtl);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_cache
      (key, agent_type, value, created_at, expires_at, ticket_id, ticket_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      key,
      agentType,
      JSON.stringify(value),
      now.toISOString(),
      expiresAt.toISOString(),
      ticketId,
      ticketUpdatedAt.toISOString()
    );

    logger.debug({ key, agentType, expiresAt: expiresAt.toISOString() }, 'Cache set');
  }

  invalidate(key: string): void {
    this.db.prepare('DELETE FROM agent_cache WHERE key = ?').run(key);
  }

  invalidateByTicket(ticketId: string): void {
    const result = this.db
      .prepare('DELETE FROM agent_cache WHERE ticket_id = ?')
      .run(ticketId);
    if (result.changes > 0) {
      logger.debug({ ticketId, deleted: result.changes }, 'Cache entries invalidated by ticket');
    }
  }

  invalidateByAgentType(agentType: AgentType): void {
    const result = this.db
      .prepare('DELETE FROM agent_cache WHERE agent_type = ?')
      .run(agentType);
    if (result.changes > 0) {
      logger.debug({ agentType, deleted: result.changes }, 'Cache entries invalidated by agent type');
    }
  }

  clearExpired(): number {
    const result = this.db
      .prepare('DELETE FROM agent_cache WHERE expires_at < ?')
      .run(new Date().toISOString());
    if (result.changes > 0) {
      logger.info({ deleted: result.changes }, 'Expired cache entries cleared');
    }
    return result.changes;
  }

  getStats(): {
    totalEntries: number;
    byAgentType: Record<string, number>;
    expiredCount: number;
  } {
    const total = this.db
      .prepare('SELECT COUNT(*) as count FROM agent_cache')
      .get() as { count: number };

    const byType = this.db
      .prepare('SELECT agent_type, COUNT(*) as count FROM agent_cache GROUP BY agent_type')
      .all() as Array<{ agent_type: string; count: number }>;

    const expired = this.db
      .prepare('SELECT COUNT(*) as count FROM agent_cache WHERE expires_at < ?')
      .get(new Date().toISOString()) as { count: number };

    return {
      totalEntries: total.count,
      byAgentType: Object.fromEntries(byType.map((r) => [r.agent_type, r.count])),
      expiredCount: expired.count,
    };
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
export const agentCache = new AgentCache();
