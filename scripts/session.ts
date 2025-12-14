#!/usr/bin/env npx tsx
/**
 * Session Management CLI
 *
 * Manage and resume Claude Code sessions.
 * Usage:
 *   npm run session list [--status=<status>]
 *   npm run session inspect <session-id|ticket-id>
 *   npm run session resume <session-id|ticket-id> [--latest]
 *   npm run session delete <session-id|ticket-id> [--older-than=<days>]
 */

import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../src/queue/database.js';
import { sessionStorage, type SessionRecord, type SessionStatus } from '../src/sessions/index.js';
import { codeExecutorAgent } from '../src/agents/impl/code-executor.js';

loadEnv();

function printUsage(): void {
  console.log(`
Session Management CLI

Usage:
  npm run session list [--status=<status>]     List sessions
  npm run session inspect <id>                 Show session details
  npm run session resume <id> [--latest]       Resume interrupted session
  npm run session delete <id> [--older-than=N] Delete session(s)

Options:
  --status=<status>    Filter by status: active, interrupted, completed, failed
  --latest             Resume the most recent resumable session
  --older-than=<days>  Delete sessions older than N days

Examples:
  npm run session list
  npm run session list --status=interrupted
  npm run session inspect abc123
  npm run session resume --latest
  npm run session delete --older-than=7
`);
}

function formatDate(date: Date): string {
  return date.toLocaleString();
}

function formatDuration(start: Date, end?: Date | null): string {
  const endTime = end?.getTime() ?? Date.now();
  const durationMs = endTime - start.getTime();
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function printSessionTable(sessions: SessionRecord[]): void {
  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log('\nSessions:\n');
  console.log(
    '  ID'.padEnd(6) +
    'Ticket'.padEnd(12) +
    'Status'.padEnd(14) +
    'Session ID'.padEnd(24) +
    'Created'.padEnd(22) +
    'Duration'
  );
  console.log('-'.repeat(90));

  for (const session of sessions) {
    const sessionIdDisplay = session.sessionId
      ? session.sessionId.slice(0, 20) + '...'
      : '(not captured)';

    console.log(
      `  ${String(session.id).padEnd(4)}` +
      `${session.ticketIdentifier.padEnd(12)}` +
      `${session.status.padEnd(14)}` +
      `${sessionIdDisplay.padEnd(24)}` +
      `${formatDate(session.createdAt).padEnd(22)}` +
      `${formatDuration(session.createdAt, session.completedAt)}`
    );
  }

  console.log(`\nTotal: ${sessions.length} session(s)\n`);
}

function printSessionDetails(session: SessionRecord): void {
  const worktreeExists = fs.existsSync(session.worktreePath);

  console.log(`
Session Details
===============

ID:              ${session.id}
Ticket:          ${session.ticketIdentifier} (${session.ticketId})
Status:          ${session.status}
Session ID:      ${session.sessionId || '(not captured)'}
Resume Count:    ${session.resumeCount}

Worktree:        ${session.worktreePath}
                 ${worktreeExists ? '(exists)' : '(MISSING - cannot resume)'}
Branch:          ${session.branchName}

Created:         ${formatDate(session.createdAt)}
Updated:         ${formatDate(session.updatedAt)}
${session.interruptedAt ? `Interrupted:     ${formatDate(session.interruptedAt)}` : ''}
${session.completedAt ? `Completed:       ${formatDate(session.completedAt)}` : ''}

${session.errorMessage ? `Error:           ${session.errorMessage}` : ''}

Prompt (first 500 chars):
${'-'.repeat(40)}
${session.prompt.slice(0, 500)}${session.prompt.length > 500 ? '...' : ''}
`);
}

async function listSessions(args: string[]): Promise<void> {
  const statusArg = args.find(a => a.startsWith('--status='));
  const status = statusArg?.split('=')[1] as SessionStatus | undefined;

  let sessions: SessionRecord[];
  if (status) {
    sessions = sessionStorage.listByStatus(status);
    console.log(`\nListing sessions with status: ${status}`);
  } else {
    sessions = sessionStorage.listAll();
    console.log('\nListing all sessions');
  }

  printSessionTable(sessions);
}

function inspectSession(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error('Error: Please provide a session ID or ticket ID');
    process.exit(1);
  }

  // Try to find session by ID (numeric) or session_id (UUID) or ticket_id
  let session: SessionRecord | null = null;

  const numId = parseInt(id, 10);
  if (!isNaN(numId)) {
    session = sessionStorage.getById(numId);
  }

  if (!session) {
    session = sessionStorage.getBySessionId(id);
  }

  if (!session) {
    session = sessionStorage.getByTicket(id);
  }

  if (!session) {
    console.error(`Error: Session not found: ${id}`);
    process.exit(1);
  }

  printSessionDetails(session);
}

async function resumeSession(args: string[]): Promise<void> {
  let session: SessionRecord | null = null;

  if (args.includes('--latest')) {
    const resumable = sessionStorage.listResumable();
    if (resumable.length === 0) {
      console.error('No resumable sessions found.');
      process.exit(1);
    }
    session = resumable[0]!;
    console.log(`Resuming most recent session: ${session.ticketIdentifier}`);
  } else {
    const id = args[0];
    if (!id) {
      console.error('Error: Please provide a session ID, ticket ID, or use --latest');
      process.exit(1);
    }

    // Try to find session by various IDs
    const numId = parseInt(id, 10);
    if (!isNaN(numId)) {
      session = sessionStorage.getById(numId);
    }

    if (!session) {
      session = sessionStorage.getBySessionId(id);
    }

    if (!session) {
      session = sessionStorage.getByTicket(id);
    }
  }

  if (!session) {
    console.error('Error: Session not found');
    process.exit(1);
  }

  // Validate session can be resumed
  if (!session.sessionId) {
    console.error('Error: Session has no Claude Code session ID - cannot resume');
    console.error('       The session may have been interrupted before the ID was captured.');
    process.exit(1);
  }

  if (!fs.existsSync(session.worktreePath)) {
    console.error(`Error: Worktree no longer exists: ${session.worktreePath}`);
    console.error('       The session cannot be resumed without the worktree.');
    process.exit(1);
  }

  if (session.status === 'completed') {
    console.error('Error: Session is already completed');
    process.exit(1);
  }

  if (session.status === 'active') {
    console.error('Warning: Session is marked as active - it may still be running');
    console.error('         Use Ctrl+C to cancel if you want to proceed anyway');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log(`
Resuming Session
================
Ticket:     ${session.ticketIdentifier}
Session ID: ${session.sessionId}
Worktree:   ${session.worktreePath}
`);

  // Mark as resumed
  sessionStorage.markResumed(session.id);

  try {
    const result = await codeExecutorAgent.resumeSession(session);

    if (result.success) {
      sessionStorage.markCompleted(session.id);
      console.log('\nSession completed successfully!');
      if (result.prUrl) {
        console.log(`PR: ${result.prUrl}`);
      }
    } else {
      sessionStorage.markFailed(session.id, result.error || 'Unknown error');
      console.error(`\nSession failed: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sessionStorage.markFailed(session.id, errorMessage);
    console.error(`\nSession failed: ${errorMessage}`);
    process.exit(1);
  }
}

function deleteSession(args: string[]): void {
  const olderThanArg = args.find(a => a.startsWith('--older-than='));

  if (olderThanArg) {
    const days = parseInt(olderThanArg.split('=')[1] ?? '0', 10);
    if (isNaN(days) || days <= 0) {
      console.error('Error: Invalid --older-than value. Must be a positive number of days.');
      process.exit(1);
    }

    const count = sessionStorage.cleanup(days, ['completed', 'failed']);
    console.log(`Deleted ${count} session(s) older than ${days} day(s)`);
    return;
  }

  const id = args[0];
  if (!id) {
    console.error('Error: Please provide a session ID or use --older-than=<days>');
    process.exit(1);
  }

  // Try to find session
  let session: SessionRecord | null = null;

  const numId = parseInt(id, 10);
  if (!isNaN(numId)) {
    session = sessionStorage.getById(numId);
  }

  if (!session) {
    session = sessionStorage.getBySessionId(id);
  }

  if (!session) {
    session = sessionStorage.getByTicket(id);
  }

  if (!session) {
    console.error(`Error: Session not found: ${id}`);
    process.exit(1);
  }

  sessionStorage.delete(session.id);
  console.log(`Deleted session ${session.id} (${session.ticketIdentifier})`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    printUsage();
    process.exit(0);
  }

  // Initialize database
  initDatabase();

  try {
    switch (command) {
      case 'list':
        await listSessions(args);
        break;
      case 'inspect':
        inspectSession(args);
        break;
      case 'resume':
        await resumeSession(args);
        break;
      case 'delete':
        deleteSession(args);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
