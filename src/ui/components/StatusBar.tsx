import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  startTime: Date;
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

export const StatusBar: React.FC<StatusBarProps> = ({ startTime }) => {
  const [currentTime, setCurrentTime] = React.useState(new Date());

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const uptime = formatDuration(currentTime.getTime() - startTime.getTime());
  const time = currentTime.toLocaleTimeString();

  return (
    <Box paddingX={1}>
      <Text dimColor>⏱ Uptime: {uptime}  │  🕐 {time}  │  Press Ctrl+C to exit</Text>
    </Box>
  );
};
