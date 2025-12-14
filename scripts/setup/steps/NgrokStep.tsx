import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, TextInput, StatusMessage } from '@inkjs/ui';
import { execSync, spawn } from 'node:child_process';

interface NgrokStepProps {
  onComplete: (ngrokUrl: string | null) => void;
}

type NgrokState =
  | 'checking'
  | 'not-installed'
  | 'installing'
  | 'not-authenticated'
  | 'auth-input'
  | 'authenticating'
  | 'starting'
  | 'ready'
  | 'error';

const WEBHOOK_PORT = '4847';

export const NgrokStep: React.FC<NgrokStepProps> = ({ onComplete }) => {
  const [state, setState] = useState<NgrokState>('checking');
  const [ngrokUrl, setNgrokUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState('');

  // Check if ngrok is installed
  useEffect(() => {
    if (state !== 'checking') return;

    try {
      execSync('which ngrok', { encoding: 'utf-8' });
      // Ngrok is installed, check if authenticated
      checkAuthentication();
    } catch {
      setState('not-installed');
    }
  }, [state]);

  const checkAuthentication = () => {
    try {
      const output = execSync('ngrok config check', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (output.includes('Valid')) {
        startNgrok();
      } else {
        setState('not-authenticated');
      }
    } catch {
      setState('not-authenticated');
    }
  };

  const installNgrok = () => {
    setState('installing');
    try {
      execSync('brew install ngrok', { stdio: 'pipe' });
      setState('not-authenticated');
    } catch (e) {
      setError('Failed to install ngrok. Please install manually: brew install ngrok');
      setState('error');
    }
  };

  const authenticateNgrok = (token: string) => {
    if (!token.trim()) {
      setError('Auth token is required');
      return;
    }

    setState('authenticating');
    try {
      execSync(`ngrok config add-authtoken ${token}`, { stdio: 'pipe' });
      startNgrok();
    } catch (e) {
      setError('Failed to authenticate ngrok');
      setState('error');
    }
  };

  const startNgrok = () => {
    setState('starting');

    const ngrokProc = spawn('ngrok', ['http', WEBHOOK_PORT, '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      ngrokProc.kill();
      setError('Timed out waiting for ngrok URL');
      setState('error');
    }, 15000);

    ngrokProc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();

      // Try to match URL from log output
      const urlMatch = text.match(/url=(https:\/\/[^\s]+\.ngrok[^\s]*)/);
      if (urlMatch && urlMatch[1]) {
        clearTimeout(timeout);
        ngrokProc.kill();
        setNgrokUrl(urlMatch[1]);
        setState('ready');
        return;
      }

      // Try JSON format
      const jsonUrlMatch = text.match(/"URL":"(https:\/\/[^"]+)"/);
      if (jsonUrlMatch && jsonUrlMatch[1]) {
        clearTimeout(timeout);
        ngrokProc.kill();
        setNgrokUrl(jsonUrlMatch[1]);
        setState('ready');
        return;
      }
    });

    ngrokProc.on('error', () => {
      clearTimeout(timeout);
      setError('Failed to start ngrok');
      setState('error');
    });
  };

  // Handle Enter to continue when ready
  useInput((input, key) => {
    if (key.return && state === 'ready') {
      onComplete(ngrokUrl);
    }
    if (key.return && state === 'error') {
      onComplete(null);
    }
  });

  // Render based on state
  switch (state) {
    case 'checking':
      return (
        <Box>
          <Spinner label="Checking ngrok installation..." />
        </Box>
      );

    case 'not-installed':
      return (
        <Box flexDirection="column">
          <Text>ngrok is not installed.</Text>
          <Box marginTop={1}>
            <Text dimColor>Installing via Homebrew...</Text>
          </Box>
          {/* Auto-install on render */}
          {(() => {
            setTimeout(installNgrok, 100);
            return null;
          })()}
        </Box>
      );

    case 'installing':
      return (
        <Box>
          <Spinner label="Installing ngrok via Homebrew..." />
        </Box>
      );

    case 'not-authenticated':
      return (
        <Box flexDirection="column">
          <StatusMessage variant="warning">ngrok requires authentication</StatusMessage>
          <Box marginTop={1} flexDirection="column">
            <Text>To get your auth token:</Text>
            <Text>  1. Sign up at <Text color="cyan">https://ngrok.com</Text></Text>
            <Text>  2. Go to <Text color="cyan">https://dashboard.ngrok.com/get-started/your-authtoken</Text></Text>
            <Text>  3. Copy your auth token</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to input your token...</Text>
          </Box>
          {/* Transition to auth input on Enter */}
          <AuthInputTrigger onTrigger={() => setState('auth-input')} />
        </Box>
      );

    case 'auth-input':
      return (
        <Box flexDirection="column">
          <Text>Paste your ngrok auth token:</Text>
          <Box marginTop={1}>
            <TextInput
              placeholder="your-auth-token"
              onChange={setAuthToken}
              onSubmit={authenticateNgrok}
            />
          </Box>
        </Box>
      );

    case 'authenticating':
      return (
        <Box>
          <Spinner label="Authenticating ngrok..." />
        </Box>
      );

    case 'starting':
      return (
        <Box>
          <Spinner label="Starting ngrok tunnel..." />
        </Box>
      );

    case 'ready':
      return (
        <Box flexDirection="column">
          <StatusMessage variant="success">ngrok tunnel ready</StatusMessage>
          <Box marginTop={1}>
            <Text>URL: <Text color="cyan">{ngrokUrl}</Text></Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue</Text>
          </Box>
        </Box>
      );

    case 'error':
      return (
        <Box flexDirection="column">
          <StatusMessage variant="error">{error || 'An error occurred'}</StatusMessage>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to continue without webhooks</Text>
          </Box>
        </Box>
      );

    default:
      return null;
  }
};

// Helper component to trigger auth input on Enter
const AuthInputTrigger: React.FC<{ onTrigger: () => void }> = ({ onTrigger }) => {
  useInput((input, key) => {
    if (key.return) {
      onTrigger();
    }
  });
  return null;
};
