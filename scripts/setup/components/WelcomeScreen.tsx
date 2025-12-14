import React from 'react';
import { Box, Text, useInput } from 'ink';

const LOGO = `
  ████████╗ █████╗ ███████╗██╗  ██╗
  ╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
     ██║   ███████║███████╗█████╔╝
     ██║   ██╔══██║╚════██║██╔═██╗
     ██║   ██║  ██║███████║██║  ██╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
`;

interface WelcomeScreenProps {
  onContinue: () => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onContinue }) => {
  useInput((input, key) => {
    if (key.return) {
      onContinue();
    }
  });

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text color="cyan" bold>
        {LOGO}
      </Text>
      <Box marginTop={1}>
        <Text color="gray">═══════════════════════════════════════</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text bold color="white">
          A G E N T {'  '} S E T U P
        </Text>
        <Text dimColor>v0.1.0</Text>
      </Box>
      <Box marginTop={2} flexDirection="column" alignItems="center">
        <Text>Welcome to TaskAgent setup!</Text>
        <Text dimColor>This wizard will help you configure TaskAgent.</Text>
      </Box>
      <Box marginTop={2}>
        <Text color="cyan">Press Enter to continue...</Text>
      </Box>
    </Box>
  );
};
