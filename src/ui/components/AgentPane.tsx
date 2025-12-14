import React from 'react';
import { Box, Text } from 'ink';
import { Spinner, Badge } from '@inkjs/ui';

export interface AgentInfo {
  id: string;
  ticketIdentifier: string;
  status: string;
  startedAt: Date;
  recentOutput: string[];
}

interface AgentPaneProps {
  agents: AgentInfo[];
  available: number;
  total: number;
}

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

const getBadgeColor = (status: string): 'green' | 'yellow' | 'red' | 'blue' => {
  switch (status) {
    case 'working':
    case 'executing':
      return 'yellow';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    default:
      return 'blue';
  }
};

export const AgentPane: React.FC<AgentPaneProps> = ({ agents, available, total }) => {
  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      {/* Header */}
      <Box
        borderStyle="double"
        borderColor="magenta"
        paddingX={2}
        marginBottom={1}
        justifyContent="center"
      >
        <Text bold color="magenta">⚡ CLAUDE CODE</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {agents.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text dimColor italic>No active sessions</Text>
            <Box marginTop={2} gap={1}>
              <Badge color="green">{available}/{total}</Badge>
              <Text>slots available</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {agents.map((agent) => {
              const runtime = formatDuration(Date.now() - agent.startedAt.getTime());
              const ticket = agent.ticketIdentifier || 'Unknown';
              const isActive = agent.status === 'working' || agent.status === 'executing';

              return (
                <Box
                  key={agent.id}
                  flexDirection="column"
                  marginBottom={1}
                  borderStyle="round"
                  borderColor="gray"
                  paddingX={1}
                >
                  {/* Agent header */}
                  <Box gap={1} paddingY={0}>
                    {isActive ? (
                      <Spinner />
                    ) : (
                      <Text color={getBadgeColor(agent.status)}>●</Text>
                    )}
                    <Text bold color="white">{ticket}</Text>
                    <Badge color={getBadgeColor(agent.status)}>{agent.status}</Badge>
                    <Text dimColor>{runtime}</Text>
                  </Box>

                  {/* Agent output */}
                  <Box flexDirection="column" paddingLeft={2} marginTop={0}>
                    {agent.recentOutput.length > 0 ? (
                      agent.recentOutput.slice(-3).map((line, idx) => (
                        <Box key={idx}>
                          <Text color="gray">│ </Text>
                          <Text>{line.slice(0, 60)}</Text>
                        </Box>
                      ))
                    ) : (
                      <Box>
                        <Text color="gray">│ </Text>
                        <Text dimColor italic>Waiting for output...</Text>
                      </Box>
                    )}
                  </Box>
                </Box>
              );
            })}

            {/* Slots available */}
            <Box marginTop={1} gap={1}>
              <Badge color="green">{available}/{total}</Badge>
              <Text>slots available</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
