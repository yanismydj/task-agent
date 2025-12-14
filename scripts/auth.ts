#!/usr/bin/env npx tsx
/**
 * Linear OAuth Authorization Script
 *
 * Run this to authorize TaskAgent with Linear before starting the daemon.
 * Usage: npm run auth
 */

import { config as loadEnv } from 'dotenv';
import { initializeAuth } from '../src/linear/auth.js';

loadEnv();

// Enhanced colors for better visibility
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  brightGreen: '\x1b[92m',
  brightRed: '\x1b[91m',
  brightCyan: '\x1b[96m',
};

const icons = {
  success: `${colors.brightGreen}✓${colors.reset}`,
  error: `${colors.brightRed}✗${colors.reset}`,
  info: `${colors.brightCyan}●${colors.reset}`,
};

async function main() {
  const clientId = process.env['LINEAR_CLIENT_ID'];
  const clientSecret = process.env['LINEAR_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    console.error(`${icons.error} ${colors.bold}Missing LINEAR_CLIENT_ID or LINEAR_CLIENT_SECRET in .env${colors.reset}`);
    console.error(`   ${colors.dim}Create an OAuth app at: https://linear.app/settings/api/applications${colors.reset}`);
    process.exit(1);
  }

  const auth = initializeAuth({ clientId, clientSecret });

  if (auth.hasValidToken()) {
    console.log(`${icons.success} ${colors.bold}Already authorized with Linear. Token is valid.${colors.reset}`);
    console.log(`   ${colors.dim}Run with --force to re-authorize.${colors.reset}\n`);

    if (!process.argv.includes('--force')) {
      process.exit(0);
    }
    console.log(`   ${icons.info} Re-authorizing...\n`);
  }

  try {
    await auth.authorize();
    process.exit(0);
  } catch (error) {
    console.error(`${icons.error} ${colors.bold}Authorization failed:${colors.reset} ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
