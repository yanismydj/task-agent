import React from 'react';
import { Box, Text } from 'ink';

export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'success' | 'debug';
  message: string;
  module?: string;
}

interface LogPaneProps {
  title: string;
  logs: LogEntry[];
  maxLines?: number;
}

const getLevelIcon = (level: LogEntry['level']): string => {
  switch (level) {
    case 'info': return '●';
    case 'success': return '✓';
    case 'warn': return '⚠';
    case 'error': return '✖';
    case 'debug': return '○';
    default: return ' ';
  }
};

const getLevelColor = (level: LogEntry['level']): string => {
  switch (level) {
    case 'info': return 'cyan';
    case 'success': return 'green';
    case 'warn': return 'yellow';
    case 'error': return 'red';
    case 'debug': return 'gray';
    default: return 'white';
  }
};

const formatTime = (date: Date): string => {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export const LogPane: React.FC<LogPaneProps> = ({ title, logs, maxLines = 15 }) => {
  const displayLogs = logs.slice(-maxLines);

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      {/* Header */}
      <Box
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        marginBottom={1}
        justifyContent="center"
      >
        <Text bold color="cyan">📋 {title}</Text>
      </Box>

      {/* Log entries */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {displayLogs.length === 0 ? (
          <Text dimColor italic>Waiting for activity...</Text>
        ) : (
          displayLogs.map((entry, index) => {
            const time = formatTime(entry.timestamp);
            const icon = getLevelIcon(entry.level);
            const color = getLevelColor(entry.level);
            const module = entry.module ? `[${entry.module}]` : '';

            return (
              <Box key={`${entry.timestamp.getTime()}-${index}`}>
                <Text dimColor>{time}</Text>
                <Text> </Text>
                <Text color={color}>{icon}</Text>
                <Text> </Text>
                {module && <Text color="blue">{module} </Text>}
                <Text color={entry.level === 'error' || entry.level === 'warn' ? color : 'white'}>
                  {entry.message}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};
