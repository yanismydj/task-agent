import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, Select, StatusMessage } from '@inkjs/ui';

interface LinearTeamStepProps {
  clientId: string;
  clientSecret: string;
  onComplete: (teamId: string) => void;
}

interface Team {
  id: string;
  name: string;
  key: string;
}

export const LinearTeamStep: React.FC<LinearTeamStepProps> = ({
  clientId,
  clientSecret,
  onComplete,
}) => {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState(false);

  useEffect(() => {
    // For now, we'll skip the API fetch and ask for manual input
    // In a full implementation, we'd use the OAuth flow here
    setLoading(false);
    setManualInput(true);
  }, []);

  useInput((input, key) => {
    if (key.return && manualInput) {
      // This is handled by the TextInput
    }
  });

  if (loading) {
    return (
      <Box>
        <Spinner label="Fetching teams from Linear..." />
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <StatusMessage variant="error">{error}</StatusMessage>
        <Box marginTop={1}>
          <Text>Please enter your team ID manually.</Text>
        </Box>
      </Box>
    );
  }

  if (manualInput || teams.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>Enter your Linear Team ID:</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            You can find this in Linear: Settings → Team Settings → General
          </Text>
          <Text dimColor>
            Look for the "Team ID" field, or use the team key from your issue IDs (e.g., "ENG" from "ENG-123")
          </Text>
        </Box>
        <Box marginTop={1}>
          <ManualTeamInput onSubmit={onComplete} />
        </Box>
      </Box>
    );
  }

  const options = teams.map((team) => ({
    label: `${team.name} (${team.key})`,
    value: team.id,
  }));

  return (
    <Box flexDirection="column">
      <Text>Select your team:</Text>
      <Box marginTop={1}>
        <Select options={options} onChange={onComplete} />
      </Box>
    </Box>
  );
};

// Separate component to handle manual input
import { TextInput } from '@inkjs/ui';

const ManualTeamInput: React.FC<{ onSubmit: (value: string) => void }> = ({
  onSubmit,
}) => {
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Team ID is required');
      return;
    }
    setError(null);
    onSubmit(value.trim());
  };

  return (
    <Box flexDirection="column">
      <TextInput placeholder="team-id-or-key" onSubmit={handleSubmit} />
      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}
    </Box>
  );
};
