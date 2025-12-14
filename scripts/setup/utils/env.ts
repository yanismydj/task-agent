/**
 * Environment file utilities for setup wizard
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
export const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
export const ENV_PATH = path.join(PROJECT_ROOT, '.env');
export const TASKAGENT_DIR = path.join(PROJECT_ROOT, '.taskagent');
export const REPO_SUMMARY_PATH = path.join(TASKAGENT_DIR, 'repo-summary.json');
export const TOKEN_PATH = path.join(TASKAGENT_DIR, 'token.json');

/**
 * Ensure .taskagent directory exists
 */
export function ensureTaskAgentDir(): void {
  if (!fs.existsSync(TASKAGENT_DIR)) {
    fs.mkdirSync(TASKAGENT_DIR, { recursive: true });
  }
}

/**
 * Load environment variables from .env file
 */
export function loadEnvFile(): Map<string, string> {
  const env = new Map<string, string>();

  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const match = trimmed.match(/^([^=]+)=(.*)$/);
        if (match) {
          env.set(match[1], match[2]);
        }
      }
    }
  }

  return env;
}

/**
 * Save environment variables to .env file, preserving template structure
 */
export function saveEnvFile(env: Map<string, string>): void {
  // Read the template to preserve comments and structure
  let content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');

  // Replace values in template
  for (const [key, value] of env) {
    // Match both KEY=value and KEY= patterns
    const regex = new RegExp(`^(${key})=.*$`, 'm');
    if (content.match(regex)) {
      content = content.replace(regex, `$1=${value}`);
    }
  }

  fs.writeFileSync(ENV_PATH, content);
}

/**
 * Check if .env file exists
 */
export function envFileExists(): boolean {
  return fs.existsSync(ENV_PATH);
}

/**
 * Create .env from .env.example
 */
export function createEnvFromExample(): void {
  fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
}

/**
 * Check if OAuth token exists
 */
export function tokenExists(): boolean {
  return fs.existsSync(TOKEN_PATH);
}
