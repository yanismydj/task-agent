import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

interface ConcurrencyStepProps {
  currentMaxConcurrent: number;
  currentMaxCodeExecutors: number;
  onComplete: (maxConcurrent: number, maxCodeExecutors: number) => void;
}

type InputField = 'maxConcurrent' | 'maxCodeExecutors';

export const ConcurrencyStep: React.FC<ConcurrencyStepProps> = ({
  currentMaxConcurrent,
  currentMaxCodeExecutors,
  onComplete,
}) => {
  const [currentField, setCurrentField] = useState<InputField>('maxConcurrent');
  const [maxConcurrent, setMaxConcurrent] = useState(currentMaxConcurrent);
  const [error, setError] = useState<string | null>(null);

  const handleMaxConcurrentSubmit = (value: string) => {
    const num = parseInt(value, 10);

    if (isNaN(num) || num < 1 || num > 20) {
      setError('Must be a number between 1 and 20');
      return;
    }

    setError(null);
    setMaxConcurrent(num);
    setCurrentField('maxCodeExecutors');
  };

  const handleMaxCodeExecutorsSubmit = (value: string) => {
    const num = parseInt(value, 10);

    if (isNaN(num) || num < 0 || num > 10) {
      setError('Must be a number between 0 and 10');
      return;
    }

    setError(null);
    onComplete(maxConcurrent, num);
  };

  if (currentField === 'maxConcurrent') {
    return (
      <Box flexDirection="column">
        <Text bold>Analysis Tasks</Text>
        <Text dimColor>How many ticket evaluation tasks can run in parallel?</Text>

        <Box marginTop={1}>
          <Text>Max concurrent analysis tasks: </Text>
          <TextInput
            defaultValue={String(currentMaxConcurrent)}
            onSubmit={handleMaxConcurrentSubmit}
          />
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Recommended: 5 for most setups</Text>
        </Box>
      </Box>
    );
  }

  if (currentField === 'maxCodeExecutors') {
    return (
      <Box flexDirection="column">
        <Text bold>Code Executors</Text>
        <Text dimColor>How many Claude Code instances can run in parallel?</Text>
        <Text dimColor>Set to 0 for analysis-only mode (no code execution)</Text>

        <Box marginTop={1}>
          <Text>Max concurrent code executors: </Text>
          <TextInput
            defaultValue={String(currentMaxCodeExecutors)}
            onSubmit={handleMaxCodeExecutorsSubmit}
          />
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color="red">✗ {error}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Recommended: 1 for development, 2-3 for production</Text>
        </Box>
      </Box>
    );
  }

  return null;
};
