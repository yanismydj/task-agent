import React from 'react';
import { Box, Text } from 'ink';

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

const getStatusIcon = (status: string): string => {
  switch (status) {
    case 'working': return '◉';
    case 'executing': return '◉';
    case 'completed': return '✓';
    case 'failed': return '✗';
    case 'assigned': return '○';
    default: return '○';
  }
};

const getStatusColor = (status: string): string => {
  switch (status) {
    case 'working':
    case 'executing':
      return 'yellow';
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'assigned': return 'blue';
    default: return 'gray';
  }
};

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

export const AgentPane: React.FC<AgentPaneProps> = ({ agents, available, total }) => {
  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">CLAUDE CODE OUTPUT</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {agents.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No active sessions</Text>
            <Box marginTop={1}>
              <Text color="green">●</Text>
              <Text> {available}/{total} slots available</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            {agents.map((agent) => {
              const runtime = formatDuration(Date.now() - agent.startedAt.getTime());
              const statusIcon = getStatusIcon(agent.status);
              const statusColor = getStatusColor(agent.status);
              const ticket = agent.ticketIdentifier || 'Unknown';

              return (
                <Box key={agent.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={statusColor}>{statusIcon} </Text>
                    <Text bold>{ticket}</Text>
                    <Text dimColor> │ </Text>
                    <Text color="cyan">{agent.status}</Text>
                    <Text dimColor> │ {runtime}</Text>
                  </Box>
                  {agent.recentOutput.length > 0 ? (
                    agent.recentOutput.map((line, idx) => (
                      <Box key={idx} paddingLeft={2}>
                        <Text dimColor>│ </Text>
                        <Text>{line}</Text>
                      </Box>
                    ))
                  ) : (
                    <Box paddingLeft={2}>
                      <Text dimColor>│ Waiting for output...</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
              <Text color="green">●</Text>
              <Text> {available}/{total} slots available</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
