import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import { LinearAuth } from '../../../src/linear/auth.js';
import { LinearClient } from '@linear/sdk';
import { startNgrok, stopNgrok } from '../../../src/utils/ngrok.js';

interface LinearAuthStepProps {
  clientId: string;
  clientSecret: string;
  ngrokUrl: string | null;
  ngrokCustomDomain?: string;
  onComplete: () => void;
}

type AuthState = 'ready' | 'starting-ngrok' | 'authorizing' | 'success' | 'error';

export const LinearAuthStep: React.FC<LinearAuthStepProps> = ({
  clientId,
  clientSecret,
  ngrokUrl,
  ngrokCustomDomain,
  onComplete,
}) => {
  const [authState, setAuthState] = useState<AuthState>('ready');
  const [error, setError] = useState<string | null>(null);

  // Cleanup ngrok on unmount
  useEffect(() => {
    return () => {
      if (ngrokCustomDomain) {
        stopNgrok();
      }
    };
  }, [ngrokCustomDomain]);

  useInput((input, key) => {
    if (key.return && authState === 'ready') {
      startAuth();
    }
    if (key.return && (authState === 'success' || authState === 'error')) {
      if (authState === 'success') {
        // Stop ngrok before moving on
        if (ngrokCustomDomain) {
          stopNgrok();
        }
        onComplete();
      }
    }
  });

  const startAuth = async () => {
    setError(null);

    try {
      // Use ngrok URL for redirect if available
      // Ngrok forwards to port 4847, so we need to listen on that port for the callback
      const redirectUri = ngrokUrl ? `${ngrokUrl}/oauth/callback` : undefined;
      const callbackPort = ngrokUrl ? 4847 : undefined;
      const auth = new LinearAuth({ clientId, clientSecret, redirectUri, callbackPort });

      // Check if we have a token that looks valid locally
      if (auth.hasValidToken()) {
        // Verify the token is actually valid by making a test API call
        try {
          const accessToken = await auth.getAccessToken();
          const client = new LinearClient({ accessToken });
          await client.viewer; // Simple API call to verify token works
          setAuthState('success');
          return;
        } catch {
          // Token was revoked or invalid - clear it and re-authorize
          auth.invalidateToken();
        }
      }

      // Start ngrok if we have a custom domain (need it for OAuth callback)
      if (ngrokCustomDomain) {
        setAuthState('starting-ngrok');
        await startNgrok(4847, ngrokCustomDomain);
      }

      setAuthState('authorizing');
      await auth.authorize();
      setAuthState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authorization failed');
      setAuthState('error');
      // Stop ngrok on error
      if (ngrokCustomDomain) {
        stopNgrok();
      }
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

  if (authState === 'starting-ngrok') {
    return (
      <Box flexDirection="column">
        <Spinner label="Starting ngrok tunnel..." />
        <Box marginTop={1}>
          <Text dimColor>Setting up {ngrokCustomDomain} for OAuth callback.</Text>
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
