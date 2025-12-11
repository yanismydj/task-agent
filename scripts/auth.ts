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

async function main() {
  const clientId = process.env['LINEAR_CLIENT_ID'];
  const clientSecret = process.env['LINEAR_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    console.error('❌ Missing LINEAR_CLIENT_ID or LINEAR_CLIENT_SECRET in .env');
    console.error('   Create an OAuth app at: https://linear.app/settings/api/applications');
    process.exit(1);
  }

  const auth = initializeAuth({ clientId, clientSecret });

  if (auth.hasValidToken()) {
    console.log('✅ Already authorized with Linear. Token is valid.');
    console.log('   Run with --force to re-authorize.\n');

    if (!process.argv.includes('--force')) {
      process.exit(0);
    }
    console.log('   Re-authorizing...\n');
  }

  try {
    await auth.authorize();
    process.exit(0);
  } catch (error) {
    console.error('❌ Authorization failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
