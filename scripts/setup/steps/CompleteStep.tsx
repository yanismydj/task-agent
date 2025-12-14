import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import type { SetupState } from '../App.js';
import {
  loadEnvFile,
  saveEnvFile,
  envFileExists,
  createEnvFromExample,
  ensureTaskAgentDir,
} from '../utils/env.js';

interface CompleteStepProps {
  state: SetupState;
  onComplete: () => void;
}

export const CompleteStep: React.FC<CompleteStepProps> = ({ state, onComplete }) => {
  const [saving, setSaving] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      // Ensure directories exist
      ensureTaskAgentDir();

      // Load or create env file
      if (!envFileExists()) {
        createEnvFromExample();
      }
      const env = loadEnvFile();

      // Update env with collected values
      env.set('AGENTS_WORK_DIR', state.workDir);
      env.set('LINEAR_CLIENT_ID', state.linearClientId);
      env.set('LINEAR_CLIENT_SECRET', state.linearClientSecret);
      env.set('LINEAR_WEBHOOK_SECRET', state.linearWebhookSecret);
      env.set('LINEAR_TEAM_ID', state.linearTeamId);
      env.set('ANTHROPIC_API_KEY', state.anthropicApiKey);
      env.set('ANTHROPIC_MODEL', state.anthropicModel);
      env.set('GITHUB_REPO', state.githubRepo);
      env.set('AGENTS_MAX_CONCURRENT', String(state.maxConcurrent));
      env.set('AGENTS_MAX_CODE_EXECUTORS', String(state.maxCodeExecutors));
      env.set('WEBHOOK_ENABLED', 'true');
      env.set('WEBHOOK_PORT', '4847');

      // Save env file
      saveEnvFile(env);

      setSaving(false);
      setSaved(true);
    } catch (e) {
      setSaving(false);
      setError(e instanceof Error ? e.message : 'Failed to save configuration');
    }
  }, [state]);

  useInput((input, key) => {
    if (key.return && (saved || error)) {
      onComplete();
    }
  });

  if (saving) {
    return (
      <Box>
        <Spinner label="Saving configuration..." />
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="error">Failed to save: {error}</StatusMessage>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to exit</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <StatusMessage variant="success">Configuration saved to .env</StatusMessage>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Summary:</Text>
        <Text>  Repository: <Text color="cyan">{state.workDir}</Text></Text>
        <Text>  Linear Workspace: <Text color="cyan">{state.workspaceSlug}</Text></Text>
        <Text>  Linear Team: <Text color="cyan">{state.linearTeamId}</Text></Text>
        <Text>  GitHub: <Text color="cyan">{state.githubRepo}</Text></Text>
        <Text>  Model: <Text color="cyan">{state.anthropicModel}</Text></Text>
        <Text>  Concurrency: <Text color="cyan">{state.maxConcurrent} analysis / {state.maxCodeExecutors} executors</Text></Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <Text bold>Next steps:</Text>
        <Text>  1. Run the OAuth flow: <Text color="cyan">npm run auth</Text></Text>
        <Text>  2. Start TaskAgent: <Text color="cyan">npm run dev</Text></Text>
      </Box>

      <Box marginTop={2}>
        <Text color="cyan">Press Enter to exit</Text>
      </Box>
    </Box>
  );
};
