#!/usr/bin/env npx tsx
/**
 * Fetches Linear teams to help find your team UUID.
 * Usage: LINEAR_API_KEY=your-key npx tsx scripts/get-linear-teams.ts
 */

import { LinearClient } from '@linear/sdk';

const apiKey = process.env['LINEAR_API_KEY'];

if (!apiKey) {
  console.error('Error: LINEAR_API_KEY environment variable is required');
  console.error('Usage: LINEAR_API_KEY=lin_api_xxx npx tsx scripts/get-linear-teams.ts');
  process.exit(1);
}

const client = new LinearClient({ apiKey });

async function main() {
  const teams = await client.teams();

  console.log('\nYour Linear Teams:\n');
  console.log('UUID                                  | Key    | Name');
  console.log('--------------------------------------|--------|------------------');

  for (const team of teams.nodes) {
    console.log(`${team.id} | ${team.key.padEnd(6)} | ${team.name}`);
  }

  console.log('\nCopy the UUID and set it as LINEAR_TEAM_ID in your .env file\n');
}

main().catch(console.error);
