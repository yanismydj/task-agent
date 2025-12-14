import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { PasswordInput, Select } from '@inkjs/ui';

interface AnthropicStepProps {
  currentApiKey: string;
  currentModel: string;
  onComplete: (apiKey: string, model: string) => void;
}

type InputField = 'apiKey' | 'model';

const MODEL_OPTIONS = [
  { label: 'claude-sonnet-4-5 (Recommended)', value: 'claude-sonnet-4-5' },
  { label: 'claude-opus-4-5 (Highest quality)', value: 'claude-opus-4-5' },
  { label: 'claude-haiku-4-5 (Fastest)', value: 'claude-haiku-4-5' },
];

export const AnthropicStep: React.FC<AnthropicStepProps> = ({
  currentApiKey,
  currentModel,
  onComplete,
}) => {
  const [currentField, setCurrentField] = useState<InputField>('apiKey');
  const [apiKey, setApiKey] = useState(currentApiKey);
  const [error, setError] = useState<string | null>(null);

  const handleApiKeySubmit = (value: string) => {
    if (!value.trim()) {
      setError('API key is required');
      return;
    }

    if (!value.startsWith('sk-ant-')) {
      setError('API key should start with sk-ant-');
      return;
    }

    setError(null);
    setApiKey(value);
    setCurrentField('model');
  };

  const handleModelSelect = (value: string) => {
    onComplete(apiKey, value);
  };

  if (currentField === 'apiKey') {
    return (
      <Box flexDirection="column">
        <Text>Get your API key from:</Text>
        <Text color="cyan">  https://console.anthropic.com/settings/keys</Text>

        <Box marginTop={1}>
          <Text>Enter your Anthropic API key:</Text>
        </Box>
        <Box marginTop={1}>
          <PasswordInput placeholder="sk-ant-..." onSubmit={handleApiKeySubmit} />
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (currentField === 'model') {
    return (
      <Box flexDirection="column">
        <Text>Select the default model:</Text>
        <Box marginTop={1}>
          <Select options={MODEL_OPTIONS} onChange={handleModelSelect} />
        </Box>
      </Box>
    );
  }

  return null;
};
