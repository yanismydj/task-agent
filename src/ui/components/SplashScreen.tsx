import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Spinner } from '@inkjs/ui';

const LOGO = `
  ████████╗ █████╗ ███████╗██╗  ██╗
  ╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
     ██║   ███████║███████╗█████╔╝
     ██║   ██╔══██║╚════██║██╔═██╗
     ██║   ██║  ██║███████║██║  ██╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
`;

interface SplashScreenProps {
  initStatus?: string;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ initStatus }) => {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      height={terminalHeight}
    >
      <Text color="cyan" bold>
        {LOGO}
      </Text>
      <Box marginTop={1}>
        <Text color="gray">═══════════════════════════════════</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text bold color="white">A G E N T</Text>
        <Text dimColor>v0.1.0</Text>
      </Box>
      <Box marginTop={2}>
        <Spinner label={initStatus || "Initializing..."} />
      </Box>
    </Box>
  );
};
