import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ module: 'cache' });

const CACHE_DIR = '.task-agent';
const CACHE_FILE = 'cache.db';

interface ReadinessCache {
  ticket_id: string;
  ticket_identifier: string;
  score: number;
  ready: number; // SQLite doesn't have boolean
  issues: string; // JSON array
  suggestions: string; // JSON array
  reasoning: string;
  evaluated_at: string; // ISO timestamp
  ticket_updated_at: string; // ISO timestamp of ticket's last update
}

interface AgentSessionCache {
  agent_id: string;
  ticket_id: string;
  ticket_identifier: string;
  worktree_path: string;
  branch_name: string;
  started_at: string;
  status: string;
  process_id: number | null;
}

class LocalCache {
  private db: Database.Database;

  constructor() {
    // Ensure cache directory exists
    const cacheDir = path.join(process.cwd(), CACHE_DIR);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const dbPath = path.join(cacheDir, CACHE_FILE);
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');

    this.initTables();
    logger.info({ dbPath }, 'Local cache initialized');
  }

  private initTables(): void {
    // Readiness evaluations cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readiness_cache (
        ticket_id TEXT PRIMARY KEY,
        ticket_identifier TEXT NOT NULL,
        score INTEGER NOT NULL,
        ready INTEGER NOT NULL,
        issues TEXT NOT NULL DEFAULT '[]',
        suggestions TEXT NOT NULL DEFAULT '[]',
        reasoning TEXT NOT NULL DEFAULT '',
        evaluated_at TEXT NOT NULL,
        ticket_updated_at TEXT NOT NULL
      )
    `);

    // Agent sessions (replaces Linear state project for sessions)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        ticket_identifier TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'working',
        process_id INTEGER
      )
    `);

    // Daemon status
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        hostname TEXT NOT NULL,
        version TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL
      )
    `);

    // Create index for faster lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_readiness_identifier ON readiness_cache(ticket_identifier)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON agent_sessions(ticket_identifier)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON agent_sessions(status)
    `);
  }

  // ============ Readiness Cache ============

  getReadiness(ticketId: string): ReadinessCache | null {
    const stmt = this.db.prepare('SELECT * FROM readiness_cache WHERE ticket_id = ?');
    return stmt.get(ticketId) as ReadinessCache | undefined ?? null;
  }

  getReadinessByIdentifier(identifier: string): ReadinessCache | null {
    const stmt = this.db.prepare('SELECT * FROM readiness_cache WHERE ticket_identifier = ?');
    return stmt.get(identifier) as ReadinessCache | undefined ?? null;
  }

  setReadiness(data: {
    ticketId: string;
    ticketIdentifier: string;
    score: number;
    ready: boolean;
    issues: string[];
    suggestions: string[];
    reasoning: string;
    ticketUpdatedAt: Date;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO readiness_cache
      (ticket_id, ticket_identifier, score, ready, issues, suggestions, reasoning, evaluated_at, ticket_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.ticketId,
      data.ticketIdentifier,
      data.score,
      data.ready ? 1 : 0,
      JSON.stringify(data.issues),
      JSON.stringify(data.suggestions),
      data.reasoning,
      new Date().toISOString(),
      data.ticketUpdatedAt.toISOString()
    );
  }

  needsEvaluation(ticketId: string, ticketUpdatedAt: Date): boolean {
    const cached = this.getReadiness(ticketId);
    if (!cached) return true;

    // Re-evaluate if ticket was updated after our evaluation
    const cachedTicketUpdate = new Date(cached.ticket_updated_at);
    return ticketUpdatedAt > cachedTicketUpdate;
  }

  clearReadiness(ticketId: string): void {
    const stmt = this.db.prepare('DELETE FROM readiness_cache WHERE ticket_id = ?');
    stmt.run(ticketId);
  }

  // ============ Agent Sessions ============

  createSession(data: {
    agentId: string;
    ticketId: string;
    ticketIdentifier: string;
    worktreePath: string;
    branchName: string;
    processId?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_sessions
      (agent_id, ticket_id, ticket_identifier, worktree_path, branch_name, started_at, status, process_id)
      VALUES (?, ?, ?, ?, ?, ?, 'working', ?)
    `);

    stmt.run(
      data.agentId,
      data.ticketId,
      data.ticketIdentifier,
      data.worktreePath,
      data.branchName,
      new Date().toISOString(),
      data.processId ?? null
    );
  }

  updateSessionStatus(agentId: string, status: 'working' | 'completed' | 'failed'): void {
    const stmt = this.db.prepare('UPDATE agent_sessions SET status = ? WHERE agent_id = ?');
    stmt.run(status, agentId);
  }

  getActiveSessionByTicket(ticketIdentifier: string): AgentSessionCache | null {
    const stmt = this.db.prepare(
      'SELECT * FROM agent_sessions WHERE ticket_identifier = ? AND status = ?'
    );
    return stmt.get(ticketIdentifier, 'working') as AgentSessionCache | undefined ?? null;
  }

  getActiveSessions(): AgentSessionCache[] {
    const stmt = this.db.prepare('SELECT * FROM agent_sessions WHERE status = ?');
    return stmt.all('working') as AgentSessionCache[];
  }

  getSession(agentId: string): AgentSessionCache | null {
    const stmt = this.db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ?');
    return stmt.get(agentId) as AgentSessionCache | undefined ?? null;
  }

  // ============ Daemon Status ============

  setDaemonStatus(data: {
    pid: number;
    hostname: string;
    version: string;
  }): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO daemon_status (id, pid, started_at, hostname, version, last_heartbeat)
      VALUES (1, ?, ?, ?, ?, ?)
    `);
    stmt.run(data.pid, now, data.hostname, data.version, now);
  }

  updateHeartbeat(): void {
    const stmt = this.db.prepare('UPDATE daemon_status SET last_heartbeat = ? WHERE id = 1');
    stmt.run(new Date().toISOString());
  }

  clearDaemonStatus(): void {
    const stmt = this.db.prepare('DELETE FROM daemon_status WHERE id = 1');
    stmt.run();
  }

  getDaemonStatus(): { pid: number; startedAt: string; lastHeartbeat: string } | null {
    const stmt = this.db.prepare('SELECT pid, started_at, last_heartbeat FROM daemon_status WHERE id = 1');
    const row = stmt.get() as { pid: number; started_at: string; last_heartbeat: string } | undefined;
    if (!row) return null;
    return {
      pid: row.pid,
      startedAt: row.started_at,
      lastHeartbeat: row.last_heartbeat,
    };
  }

  // ============ Utility ============

  close(): void {
    this.db.close();
  }
}

// Singleton instance
export const localCache = new LocalCache();
