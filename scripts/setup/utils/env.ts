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

  // Track which keys we've set
  const setKeys = new Set<string>();

  // Replace values in template (including commented-out keys)
  for (const [key, value] of env) {
    // Match uncommented KEY=value patterns
    const uncommentedRegex = new RegExp(`^(${key})=.*$`, 'm');
    if (content.match(uncommentedRegex)) {
      content = content.replace(uncommentedRegex, `$1=${value}`);
      setKeys.add(key);
      continue;
    }

    // Match commented # KEY=value patterns and uncomment them
    const commentedRegex = new RegExp(`^#\\s*(${key})=.*$`, 'm');
    if (content.match(commentedRegex)) {
      content = content.replace(commentedRegex, `$1=${value}`);
      setKeys.add(key);
      continue;
    }
  }

  // Append any keys that weren't in the template at all
  const missingKeys = [...env.entries()].filter(([key]) => !setKeys.has(key));
  if (missingKeys.length > 0) {
    content += '\n# Additional configuration\n';
    for (const [key, value] of missingKeys) {
      content += `${key}=${value}\n`;
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
