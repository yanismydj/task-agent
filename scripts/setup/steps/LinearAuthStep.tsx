import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { LinearAuth } from '../../../src/linear/auth.js';

interface LinearAuthStepProps {
  clientId: string;
  clientSecret: string;
  onComplete: () => void;
}

type AuthState = 'ready' | 'authorizing' | 'success' | 'error';

export const LinearAuthStep: React.FC<LinearAuthStepProps> = ({
  clientId,
  clientSecret,
  onComplete,
}) => {
  const [authState, setAuthState] = useState<AuthState>('ready');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.return && authState === 'ready') {
      startAuth();
    }
    if (key.return && (authState === 'success' || authState === 'error')) {
      if (authState === 'success') {
        onComplete();
      }
    }
  });

  const startAuth = async () => {
    setAuthState('authorizing');
    setError(null);

    try {
      const auth = new LinearAuth({ clientId, clientSecret });

      // Check if we already have a valid token
      if (auth.hasValidToken()) {
        setAuthState('success');
        return;
      }

      await auth.authorize();
      setAuthState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authorization failed');
      setAuthState('error');
    }
  };

  if (authState === 'ready') {
    return (
      <Box flexDirection="column">
        <Text bold>Authorize with Linear</Text>
        <Text dimColor>We need to connect TaskAgent to your Linear workspace.</Text>

        <Box marginTop={1} flexDirection="column">
          <Text>This will:</Text>
          <Text dimColor>  1. Open your browser to Linear's authorization page</Text>
          <Text dimColor>  2. Ask you to approve TaskAgent's access</Text>
          <Text dimColor>  3. Redirect back to complete the setup</Text>
        </Box>

        <Box marginTop={2}>
          <Text color="cyan">Press Enter to open browser and authorize...</Text>
        </Box>
      </Box>
    );
  }

  if (authState === 'authorizing') {
    return (
      <Box flexDirection="column">
        <Spinner label="Waiting for authorization..." />
        <Box marginTop={1}>
          <Text dimColor>Complete the authorization in your browser.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>If the browser didn't open, check your terminal for the URL.</Text>
        </Box>
      </Box>
    );
  }

  if (authState === 'success') {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="success">Authorization successful!</StatusMessage>
        <Box marginTop={1}>
          <Text dimColor>TaskAgent is now connected to your Linear workspace.</Text>
        </Box>
        <Box marginTop={2}>
          <Text color="cyan">Press Enter to continue...</Text>
        </Box>
      </Box>
    );
  }

  if (authState === 'error') {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="error">Authorization failed</StatusMessage>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={2}>
          <Text dimColor>Press Enter to try again, or Ctrl+C to exit.</Text>
        </Box>
      </Box>
    );
  }

  return null;
};
