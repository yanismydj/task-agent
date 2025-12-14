import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { TextInput, StatusMessage } from '@inkjs/ui';
import { execSync } from 'node:child_process';

interface GitHubStepProps {
  workDir: string;
  currentValue: string;
  onComplete: (repo: string) => void;
}

export const GitHubStep: React.FC<GitHubStepProps> = ({
  workDir,
  currentValue,
  onComplete,
}) => {
  const [detectedRepo, setDetectedRepo] = useState<string | null>(null);
  const [showInput, setShowInput] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Try to detect GitHub repo from git remote
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        encoding: 'utf-8',
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Parse GitHub URL
      // Formats: git@github.com:owner/repo.git, https://github.com/owner/repo.git
      let match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (match) {
        const repo = `${match[1]}/${match[2]}`;
        setDetectedRepo(repo);
        // Auto-complete with detected repo
        onComplete(repo);
        return;
      }
    } catch {
      // Git command failed, show input
    }

    setShowInput(true);
  }, [workDir, onComplete]);

  const handleSubmit = (value: string) => {
    const repo = value.trim();

    if (!repo) {
      setError('Repository is required');
      return;
    }

    if (!repo.includes('/')) {
      setError('Repository should be in format: owner/repo');
      return;
    }

    setError(null);
    onComplete(repo);
  };

  if (detectedRepo && !showInput) {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="success">
          Auto-detected: {detectedRepo}
        </StatusMessage>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Enter the GitHub repository (owner/repo):</Text>
      <Box marginTop={1}>
        <TextInput
          defaultValue={currentValue}
          placeholder="owner/repo"
          onSubmit={handleSubmit}
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
