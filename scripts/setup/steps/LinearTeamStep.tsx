import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner, Select, StatusMessage } from '@inkjs/ui';
import { LinearClient } from '@linear/sdk';
import { LinearAuth } from '../../../src/linear/auth.js';

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
    const fetchTeams = async () => {
      try {
        // Get access token from stored OAuth credentials
        const auth = new LinearAuth({ clientId, clientSecret });
        const accessToken = await auth.getAccessToken();

        const client = new LinearClient({ accessToken });
        const teamsResult = await client.teams();

        const fetchedTeams = teamsResult.nodes.map((team) => ({
          id: team.id,
          name: team.name,
          key: team.key,
        }));

        if (fetchedTeams.length === 0) {
          setError('No teams found in your Linear workspace');
          setManualInput(true);
        } else {
          setTeams(fetchedTeams);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch teams');
        setManualInput(true);
      } finally {
        setLoading(false);
      }
    };

    fetchTeams();
  }, [clientId, clientSecret]);

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
        <Text>Enter your Linear Team UUID:</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            You can find this in Linear: Settings → Team Settings → General
          </Text>
          <Text dimColor>
            The Team ID is a UUID like: 12345678-1234-1234-1234-123456789abc
          </Text>
          <Text dimColor color="yellow">
            Note: This must be the UUID, not the team key (e.g., not "ENG")
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
        <Select options={options} onChange={onComplete} visibleOptionCount={15} />
      </Box>
    </Box>
  );
};

// Separate component to handle manual input
import { TextInput } from '@inkjs/ui';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ManualTeamInput: React.FC<{ onSubmit: (value: string) => void }> = ({
  onSubmit,
}) => {
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Team UUID is required');
      return;
    }
    if (!UUID_REGEX.test(trimmed)) {
      setError('Invalid UUID format. Must be like: 12345678-1234-1234-1234-123456789abc');
      return;
    }
    setError(null);
    onSubmit(trimmed);
  };

  return (
    <Box flexDirection="column">
      <TextInput placeholder="team-uuid" onSubmit={handleSubmit} />
      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}
    </Box>
  );
};
