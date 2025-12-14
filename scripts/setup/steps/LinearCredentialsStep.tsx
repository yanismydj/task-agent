import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput, PasswordInput } from '@inkjs/ui';

interface LinearCredentialsStepProps {
  onComplete: (clientId: string, clientSecret: string) => void;
}

type InputField = 'clientId' | 'clientSecret';

export const LinearCredentialsStep: React.FC<LinearCredentialsStepProps> = ({
  onComplete,
}) => {
  const [currentField, setCurrentField] = useState<InputField>('clientId');
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    onComplete(clientId, value);
  };

  if (currentField === 'clientId') {
    return (
      <Box flexDirection="column">
        <Text bold>Client Credentials</Text>
        <Text dimColor>Now scroll back up to the top of the Linear OAuth app page.</Text>

        <Box marginTop={1}>
          <Text>Enter the Client ID:</Text>
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
        <Text>Enter the Client Secret:</Text>
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
