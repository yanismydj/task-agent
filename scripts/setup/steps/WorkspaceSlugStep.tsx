import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

interface WorkspaceSlugStepProps {
  currentValue: string;
  onComplete: (workspaceSlug: string) => void;
}

export const WorkspaceSlugStep: React.FC<WorkspaceSlugStepProps> = ({
  currentValue,
  onComplete,
}) => {
  const [value, setValue] = useState(currentValue);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (inputValue: string) => {
    const slug = inputValue.trim();

    if (!slug) {
      setError('Workspace slug is required');
      return;
    }

    // Basic validation - no spaces or special characters
    if (!/^[a-z0-9-]+$/i.test(slug)) {
      setError('Workspace slug should only contain letters, numbers, and hyphens');
      return;
    }

    setError(null);
    onComplete(slug);
  };

  return (
    <Box flexDirection="column">
      <Text>For example, if you access Linear at:</Text>
      <Text color="cyan">  https://linear.app/mycompany/...</Text>
      <Text>then your workspace slug is: <Text bold>mycompany</Text></Text>

      <Box marginTop={1}>
        <Text dimColor>Workspace slug: </Text>
        <TextInput
          defaultValue={value}
          placeholder="your-workspace"
          onSubmit={handleSubmit}
          onChange={setValue}
        />
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Press Enter to continue</Text>
      </Box>
    </Box>
  );
};
