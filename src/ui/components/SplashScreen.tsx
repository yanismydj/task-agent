import React from 'react';
import { Box, Text } from 'ink';

const LOGO = `
  ████████╗ █████╗ ███████╗██╗  ██╗
  ╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
     ██║   ███████║███████╗█████╔╝
     ██║   ██╔══██║╚════██║██╔═██╗
     ██║   ██║  ██║███████║██║  ██╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ═══════════════════════════════════
       A G E N T  v0.1.0
`;

export const SplashScreen: React.FC = () => {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
      <Text color="cyan" bold>
        {LOGO}
      </Text>
    </Box>
  );
};
