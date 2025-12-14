#!/usr/bin/env npx tsx
/**
 * One-time script to create TaskAgent trigger labels in Linear
 *
 * Usage: npm run create-labels
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

// Load environment
config();

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TASKAGENT_DIR = path.join(PROJECT_ROOT, '.taskagent');
const TOKEN_PATH = path.join(TASKAGENT_DIR, 'token.json');

// Label group configuration
const LABEL_GROUP = {
  name: 'task_agent',
  color: '#6366f1', // Indigo
  description: 'TaskAgent trigger labels',
};

const TRIGGER_LABELS = [
  { name: 'clarify', color: '#0ea5e9', description: 'Ask clarifying questions' },
  { name: 'refine', color: '#8b5cf6', description: 'Refine/rewrite the description' },
  { name: 'work', color: '#22c55e', description: 'Start working on this issue' },
  { name: 'plan', color: '#f59e0b', description: 'Enter planning mode' },
];

async function main() {
  console.log('Creating TaskAgent trigger labels...\n');

  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;

  if (!teamId) {
    console.error('ERROR: LINEAR_TEAM_ID not set in environment');
    process.exit(1);
  }

  // Dynamic import
  const { LinearClient } = await import('@linear/sdk');

  let client: InstanceType<typeof LinearClient>;

  if (apiKey) {
    client = new LinearClient({ apiKey });
  } else if (fs.existsSync(TOKEN_PATH)) {
    const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    client = new LinearClient({ accessToken: tokenData.access_token });
  } else {
    console.error('ERROR: No LINEAR_API_KEY or OAuth token found');
    process.exit(1);
  }

  // Get existing labels
  const team = await client.team(teamId);
  const existingLabels = await team.labels();
  const existingByName = new Map(existingLabels.nodes.map(l => [l.name.toLowerCase(), l]));

  let created = 0;
  let deleted = 0;
  let skipped = 0;

  // Step 1: Check if task_agent exists and whether it's team or workspace level
  let parentLabelId: string;
  const existingParent = existingByName.get(LABEL_GROUP.name.toLowerCase());

  if (existingParent) {
    const parentTeam = await existingParent.team;
    const isGroup = existingParent.isGroup;

    if (!parentTeam || !isGroup) {
      // It's either workspace-level or not a group - delete it and recreate properly
      const reason = !parentTeam ? 'workspace level' : 'not a group';
      console.log(`⚠ Label "${LABEL_GROUP.name}" exists but is ${reason}, deleting...`);
      await client.deleteIssueLabel(existingParent.id);
      deleted++;

      const parentResult = await client.createIssueLabel({
        name: LABEL_GROUP.name,
        color: LABEL_GROUP.color,
        description: LABEL_GROUP.description,
        teamId,
        isGroup: true, // Mark as a group label
      });
      const parentLabel = await parentResult.issueLabel;
      if (!parentLabel) {
        console.error('ERROR: Failed to create parent label');
        process.exit(1);
      }
      parentLabelId = parentLabel.id;
      console.log(`✓ Recreated label group "${LABEL_GROUP.name}" as team-level group`);
      created++;
    } else {
      console.log(`✓ Label group "${LABEL_GROUP.name}" already exists correctly`);
      parentLabelId = existingParent.id;
    }
  } else {
    const parentResult = await client.createIssueLabel({
      name: LABEL_GROUP.name,
      color: LABEL_GROUP.color,
      description: LABEL_GROUP.description,
      teamId,
      isGroup: true, // Mark as a group label
    });
    const parentLabel = await parentResult.issueLabel;
    if (!parentLabel) {
      console.error('ERROR: Failed to create parent label');
      process.exit(1);
    }
    parentLabelId = parentLabel.id;
    console.log(`✓ Created label group "${LABEL_GROUP.name}"`);
    created++;
  }

  // Step 2: Create or update child labels
  // Need to refresh labels after potential deletion
  const refreshedLabels = await team.labels();
  const refreshedByName = new Map(refreshedLabels.nodes.map(l => [l.name.toLowerCase(), l]));

  for (const label of TRIGGER_LABELS) {
    const existingChild = refreshedByName.get(label.name.toLowerCase());

    if (existingChild) {
      // Check if it already has the correct parent
      const parent = await existingChild.parent;
      if (parent?.id === parentLabelId) {
        console.log(`● Label "${label.name}" already under ${LABEL_GROUP.name}`);
        skipped++;
      } else {
        // Delete and recreate with correct parent
        console.log(`⚠ Label "${label.name}" exists but not under ${LABEL_GROUP.name}, recreating...`);
        await client.deleteIssueLabel(existingChild.id);
        deleted++;

        await client.createIssueLabel({
          name: label.name,
          color: label.color,
          description: label.description,
          teamId,
          parentId: parentLabelId,
        });
        console.log(`✓ Recreated label "${LABEL_GROUP.name}/${label.name}"`);
        created++;
      }
    } else {
      await client.createIssueLabel({
        name: label.name,
        color: label.color,
        description: label.description,
        teamId,
        parentId: parentLabelId,
      });
      console.log(`✓ Created label "${LABEL_GROUP.name}/${label.name}"`);
      created++;
    }
  }

  console.log(`\nDone! Created ${created}, deleted ${deleted}, skipped ${skipped}.`);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
