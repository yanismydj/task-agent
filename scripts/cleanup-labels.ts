#!/usr/bin/env npx tsx
/**
 * Script to remove all ta:* labels from Linear tickets
 * Run with: npx tsx scripts/cleanup-labels.ts
 */

import { LinearClient } from '@linear/sdk';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.LINEAR_API_KEY;
const teamId = process.env.LINEAR_TEAM_ID;

if (!apiKey || !teamId) {
  console.error('Missing LINEAR_API_KEY or LINEAR_TEAM_ID in .env');
  process.exit(1);
}

async function main() {
  const client = new LinearClient({ apiKey });

  console.log('Fetching team labels...');
  const team = await client.team(teamId);
  const teamLabels = await team.labels();

  // Find all ta:* labels
  const taLabels = teamLabels.nodes.filter(l => l.name.startsWith('ta:') || l.name === 'task-agent');
  console.log(`Found ${taLabels.length} TaskAgent labels:`, taLabels.map(l => l.name));

  if (taLabels.length === 0) {
    console.log('No TaskAgent labels to clean up!');
    return;
  }

  // Get all issues with ta:* labels
  console.log('\nFetching issues with TaskAgent labels...');
  const issues = await client.issues({
    filter: {
      team: { id: { eq: teamId } },
      labels: { name: { in: taLabels.map(l => l.name) } },
    },
  });

  console.log(`Found ${issues.nodes.length} issues with TaskAgent labels`);

  // Remove labels from each issue
  for (const issue of issues.nodes) {
    const labels = await issue.labels();
    const currentLabelNames = labels.nodes.map(l => l.name);
    const hasTaskAgentLabels = currentLabelNames.some(name => name.startsWith('ta:') || name === 'task-agent');

    if (!hasTaskAgentLabels) continue;

    // Keep only non-ta:* labels
    const newLabelIds = labels.nodes
      .filter(l => !l.name.startsWith('ta:') && l.name !== 'task-agent')
      .map(l => l.id);

    console.log(`  ${issue.identifier}: Removing ta:* labels (keeping ${newLabelIds.length} other labels)`);
    await client.updateIssue(issue.id, { labelIds: newLabelIds });
  }

  // Now delete the label definitions themselves
  console.log('\nDeleting label definitions...');
  for (const label of taLabels) {
    console.log(`  Deleting label: ${label.name}`);
    try {
      await label.delete();
    } catch (e) {
      console.log(`    Warning: Could not delete ${label.name}: ${e}`);
    }
  }

  console.log('\nDone! All TaskAgent labels cleaned up.');
}

main().catch(console.error);
