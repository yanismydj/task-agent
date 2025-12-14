import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput, PasswordInput, Alert } from '@inkjs/ui';

interface LinearOAuthStepProps {
  workspaceSlug: string;
  ngrokUrl: string | null;
  onComplete: (clientId: string, clientSecret: string, webhookSecret: string) => void;
}

type InputField = 'instructions' | 'clientId' | 'clientSecret' | 'webhookSecret';

export const LinearOAuthStep: React.FC<LinearOAuthStepProps> = ({
  workspaceSlug,
  ngrokUrl,
  onComplete,
}) => {
  const [currentField, setCurrentField] = useState<InputField>('instructions');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  const oauthCallbackUrl = ngrokUrl
    ? `${ngrokUrl}/oauth/callback`
    : 'http://localhost:3456/oauth/callback';
  const webhookUrl = ngrokUrl ? `${ngrokUrl}/webhook` : '<ngrok-url>/webhook';

  useInput((input, key) => {
    if (key.return && currentField === 'instructions') {
      setCurrentField('webhookSecret');
    }
  });

  const handleWebhookSecretSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Webhook signing secret is required');
      return;
    }
    setError(null);
    setWebhookSecret(value);
    setCurrentField('clientId');
  };

  const handleClientIdSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Client ID is required');
      return;
    }
    setError(null);
    setClientId(value);
    setCurrentField('clientSecret');
  };

  const handleClientSecretSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Client Secret is required');
      return;
    }
    setError(null);
    setClientSecret(value);
    onComplete(clientId, value, webhookSecret);
  };

  if (currentField === 'instructions') {
    return (
      <Box flexDirection="column">
        <Text bold>Create a Linear OAuth Application:</Text>

        <Box marginTop={1} flexDirection="column">
          <Text>1. Go to:</Text>
          <Text color="cyan">   https://linear.app/{workspaceSlug}/settings/api/applications/new</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text>2. Fill in the application details:</Text>
          <Text dimColor>   Application name: TaskAgent</Text>
          <Text dimColor>   Developer name: Your name</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text>3. Callback URLs:</Text>
          <Text color="cyan">   {oauthCallbackUrl}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text>4. <Text bold>Webhooks:</Text> ☑ Check this box</Text>
          <Text dimColor>   This reveals additional options:</Text>
          <Box marginLeft={3} flexDirection="column">
            <Text>Webhook URL: <Text color="cyan">{webhookUrl}</Text></Text>
            <Text>Data change events: ☑ Issues, ☑ Issue labels, ☑ Comments, ☑ Emoji reactions</Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text>5. Click <Text bold>Create</Text></Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>After creating the app, Linear will show you:</Text>
          <Text dimColor>   • Webhook signing secret (scroll down to the webhook section)</Text>
          <Text dimColor>   • Client ID and Client Secret (at the top)</Text>
        </Box>

        <Box marginTop={2}>
          <Text dimColor>Note: TaskAgent manages ngrok automatically when the daemon is running.</Text>
        </Box>

        <Box marginTop={2} flexDirection="column">
          <Text>We'll ask you to enter these 3 values next:</Text>
          <Text dimColor>   1. Webhook signing secret (scroll down to webhook section)</Text>
          <Text dimColor>   2. Client ID (at the top of the page)</Text>
          <Text dimColor>   3. Client Secret (at the top of the page)</Text>
        </Box>

        <Box marginTop={2}>
          <Text color="cyan">Press Enter after creating the application...</Text>
        </Box>
      </Box>
    );
  }

  if (currentField === 'webhookSecret') {
    return (
      <Box flexDirection="column">
        <Text bold>Webhook Signing Secret</Text>
        <Text dimColor>Scroll down on your Linear OAuth app page to find the webhook section.</Text>
        <Text dimColor>Copy the "Signing secret" value.</Text>

        <Box marginTop={1}>
          <Text>Enter the Webhook signing secret:</Text>
        </Box>
        <Box marginTop={1}>
          <PasswordInput placeholder="webhook-signing-secret" onSubmit={handleWebhookSecretSubmit} />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (currentField === 'clientId') {
    return (
      <Box flexDirection="column">
        <Text bold>Client Credentials</Text>
        <Text dimColor>Now scroll back up to the top of the page to find the Client ID.</Text>

        <Box marginTop={1}>
          <Text>Enter the Client ID from Linear:</Text>
        </Box>
        <Box marginTop={1}>
          <TextInput placeholder="client-id" onSubmit={handleClientIdSubmit} />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (currentField === 'clientSecret') {
    return (
      <Box flexDirection="column">
        <Text>Enter the Client Secret from Linear:</Text>
        <Box marginTop={1}>
          <PasswordInput placeholder="client-secret" onSubmit={handleClientSecretSubmit} />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  return null;
};
