import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';
import fs from 'node:fs';
import path from 'node:path';

interface TargetRepoStepProps {
  currentValue: string;
  onComplete: (workDir: string) => void;
}

export const TargetRepoStep: React.FC<TargetRepoStepProps> = ({
  currentValue,
  onComplete,
}) => {
  const [value, setValue] = useState(currentValue || process.cwd());
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (inputValue: string) => {
    const resolvedPath = path.resolve(inputValue);

    if (!fs.existsSync(resolvedPath)) {
      setError(`Directory does not exist: ${resolvedPath}`);
      return;
    }

    if (!fs.statSync(resolvedPath).isDirectory()) {
      setError(`Not a directory: ${resolvedPath}`);
      return;
    }

    // Check if it's a git repo (warning only)
    const isGitRepo = fs.existsSync(path.join(resolvedPath, '.git'));

    setError(null);
    onComplete(resolvedPath);
  };

  return (
    <Box flexDirection="column">
      <Text>Enter the path to your target repository:</Text>
      <Box marginTop={1}>
        <Text dimColor>Path: </Text>
        <TextInput
          defaultValue={value}
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
