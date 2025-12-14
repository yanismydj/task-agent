import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput, PasswordInput } from '@inkjs/ui';

interface LinearCredentialsStepProps {
  currentClientId: string;
  currentClientSecret: string;
  onComplete: (clientId: string, clientSecret: string) => void;
}

type InputField = 'clientId' | 'clientSecret';

export const LinearCredentialsStep: React.FC<LinearCredentialsStepProps> = ({
  currentClientId,
  currentClientSecret,
  onComplete,
}) => {
  const [currentField, setCurrentField] = useState<InputField>('clientId');
  const [clientId, setClientId] = useState(currentClientId);
  const [error, setError] = useState<string | null>(null);

  const handleClientIdSubmit = (value: string) => {
    // Use existing value if user just pressed Enter
    const finalValue = value.trim() || currentClientId;
    if (!finalValue) {
      setError('Client ID is required');
      return;
    }
    setError(null);
    setClientId(finalValue);
    setCurrentField('clientSecret');
  };

  const handleClientSecretSubmit = (value: string) => {
    // Use existing value if user just pressed Enter
    const finalValue = value.trim() || currentClientSecret;
    if (!finalValue) {
      setError('Client Secret is required');
      return;
    }
    setError(null);
    onComplete(clientId, finalValue);
  };

  if (currentField === 'clientId') {
    return (
      <Box flexDirection="column">
        <Text bold>Client Credentials</Text>
        <Text dimColor>Now scroll back up to the top of the Linear OAuth app page.</Text>

        <Box marginTop={1}>
          <Text>Enter the Client ID:</Text>
        </Box>
        {currentClientId && (
          <Box marginTop={1}>
            <Text dimColor>(Press Enter to keep existing value)</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <TextInput
            defaultValue={currentClientId}
            placeholder="client-id"
            onSubmit={handleClientIdSubmit}
          />
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
        <Text>Enter the Client Secret:</Text>
        {currentClientSecret && (
          <Box marginTop={1}>
            <Text dimColor>(Press Enter to keep existing value)</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <PasswordInput
            defaultValue={currentClientSecret}
            placeholder="client-secret"
            onSubmit={handleClientSecretSubmit}
          />
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
