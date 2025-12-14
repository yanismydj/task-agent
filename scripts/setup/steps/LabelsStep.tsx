import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { LinearClient } from '@linear/sdk';
import { LinearAuth } from '../../../src/linear/auth.js';

interface LabelsStepProps {
  clientId: string;
  clientSecret: string;
  teamId: string;
  onComplete: () => void;
}

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

type LabelStatus = 'pending' | 'creating' | 'exists' | 'created' | 'error';

interface LabelState {
  name: string;
  status: LabelStatus;
  error?: string;
}

export const LabelsStep: React.FC<LabelsStepProps> = ({
  clientId,
  clientSecret,
  teamId,
  onComplete,
}) => {
  const [status, setStatus] = useState<'creating' | 'done' | 'error'>('creating');
  const [error, setError] = useState<string | null>(null);
  const [parentStatus, setParentStatus] = useState<LabelStatus>('pending');
  const [labelStates, setLabelStates] = useState<LabelState[]>(
    TRIGGER_LABELS.map((l) => ({ name: l.name, status: 'pending' }))
  );

  useEffect(() => {
    createLabels();
  }, []);

  const createLabels = async () => {
    try {
      // Get access token
      const auth = new LinearAuth({ clientId, clientSecret });
      const accessToken = await auth.getAccessToken();
      const client = new LinearClient({ accessToken });

      // Get existing labels
      const team = await client.team(teamId);
      const existingLabels = await team.labels();
      const existingByName = new Map(
        existingLabels.nodes.map((l) => [l.name.toLowerCase(), l])
      );

      // Step 1: Create or verify parent label group
      setParentStatus('creating');
      let parentLabelId: string;
      const existingParent = existingByName.get(LABEL_GROUP.name.toLowerCase());

      if (existingParent) {
        const parentTeam = await existingParent.team;
        const isGroup = existingParent.isGroup;

        if (!parentTeam || !isGroup) {
          // Delete and recreate properly
          await client.deleteIssueLabel(existingParent.id);
          const parentResult = await client.createIssueLabel({
            name: LABEL_GROUP.name,
            color: LABEL_GROUP.color,
            description: LABEL_GROUP.description,
            teamId,
            isGroup: true,
          });
          const parentLabel = await parentResult.issueLabel;
          if (!parentLabel) throw new Error('Failed to create parent label');
          parentLabelId = parentLabel.id;
          setParentStatus('created');
        } else {
          parentLabelId = existingParent.id;
          setParentStatus('exists');
        }
      } else {
        const parentResult = await client.createIssueLabel({
          name: LABEL_GROUP.name,
          color: LABEL_GROUP.color,
          description: LABEL_GROUP.description,
          teamId,
          isGroup: true,
        });
        const parentLabel = await parentResult.issueLabel;
        if (!parentLabel) throw new Error('Failed to create parent label');
        parentLabelId = parentLabel.id;
        setParentStatus('created');
      }

      // Step 2: Create child labels
      // Refresh labels after potential changes
      const refreshedLabels = await team.labels();
      const refreshedByName = new Map(
        refreshedLabels.nodes.map((l) => [l.name.toLowerCase(), l])
      );

      for (let i = 0; i < TRIGGER_LABELS.length; i++) {
        const label = TRIGGER_LABELS[i];
        setLabelStates((prev) =>
          prev.map((l, idx) => (idx === i ? { ...l, status: 'creating' } : l))
        );

        const existingChild = refreshedByName.get(label.name.toLowerCase());

        if (existingChild) {
          const parent = await existingChild.parent;
          if (parent?.id === parentLabelId) {
            setLabelStates((prev) =>
              prev.map((l, idx) => (idx === i ? { ...l, status: 'exists' } : l))
            );
          } else {
            // Delete and recreate with correct parent
            await client.deleteIssueLabel(existingChild.id);
            await client.createIssueLabel({
              name: label.name,
              color: label.color,
              description: label.description,
              teamId,
              parentId: parentLabelId,
            });
            setLabelStates((prev) =>
              prev.map((l, idx) => (idx === i ? { ...l, status: 'created' } : l))
            );
          }
        } else {
          await client.createIssueLabel({
            name: label.name,
            color: label.color,
            description: label.description,
            teamId,
            parentId: parentLabelId,
          });
          setLabelStates((prev) =>
            prev.map((l, idx) => (idx === i ? { ...l, status: 'created' } : l))
          );
        }
      }

      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create labels');
      setStatus('error');
    }
  };

  useInput((input, key) => {
    if (key.return && (status === 'done' || status === 'error')) {
      onComplete();
    }
  });

  const getStatusIcon = (s: LabelStatus) => {
    switch (s) {
      case 'pending':
        return '○';
      case 'creating':
        return '◐';
      case 'exists':
        return '●';
      case 'created':
        return '✓';
      case 'error':
        return '✗';
    }
  };

  const getStatusColor = (s: LabelStatus) => {
    switch (s) {
      case 'pending':
        return 'gray';
      case 'creating':
        return 'yellow';
      case 'exists':
        return 'blue';
      case 'created':
        return 'green';
      case 'error':
        return 'red';
    }
  };

  return (
    <Box flexDirection="column">
      <Text>Creating TaskAgent trigger labels in Linear...</Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={getStatusColor(parentStatus)}>
            {getStatusIcon(parentStatus)}
          </Text>
          <Text> {LABEL_GROUP.name} </Text>
          <Text dimColor>(label group)</Text>
        </Box>

        {labelStates.map((label) => (
          <Box key={label.name} marginLeft={2}>
            <Text color={getStatusColor(label.status)}>
              {getStatusIcon(label.status)}
            </Text>
            <Text> {label.name}</Text>
          </Box>
        ))}
      </Box>

      {status === 'creating' && (
        <Box marginTop={1}>
          <Spinner label="Creating labels..." />
        </Box>
      )}

      {status === 'done' && (
        <Box marginTop={1} flexDirection="column">
          <StatusMessage variant="success">Labels created successfully</StatusMessage>
          <Box marginTop={1}>
            <Text dimColor>
              Apply these labels to issues to trigger TaskAgent actions
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color="cyan">Press Enter to continue</Text>
          </Box>
        </Box>
      )}

      {status === 'error' && (
        <Box marginTop={1} flexDirection="column">
          <StatusMessage variant="error">Failed to create labels</StatusMessage>
          {error && (
            <Box marginTop={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue anyway</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
