import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { PasswordInput } from '@inkjs/ui';

interface LinearOAuthStepProps {
  workspaceSlug: string;
  ngrokUrl: string | null;
  currentWebhookSecret: string;
  onComplete: (webhookSecret: string) => void;
}

export const LinearOAuthStep: React.FC<LinearOAuthStepProps> = ({
  workspaceSlug,
  ngrokUrl,
  currentWebhookSecret,
  onComplete,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [webhookSecret, setWebhookSecret] = useState(currentWebhookSecret);

  const oauthCallbackUrl = ngrokUrl
    ? `${ngrokUrl}/oauth/callback`
    : 'http://localhost:3456/oauth/callback';
  const webhookUrl = ngrokUrl ? `${ngrokUrl}/webhook` : '<ngrok-url>/webhook';

  const handleWebhookSecretSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Webhook signing secret is required');
      return;
    }
    setError(null);
    onComplete(value);
  };

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
        <Text>5. Click <Text bold>Create</Text>, then scroll down to the webhook section</Text>
      </Box>

      <Box marginTop={2}>
        <Text dimColor>Note: TaskAgent manages ngrok automatically when the daemon is running.</Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <Text>6. Enter the <Text bold>Webhook signing secret</Text> from the webhook section:</Text>
        <Box marginTop={1}>
          <PasswordInput
            defaultValue={currentWebhookSecret}
            placeholder="webhook-signing-secret"
            onSubmit={handleWebhookSecretSubmit}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
