import React from 'react';
import { Box, Text } from 'ink';

interface StepContainerProps {
  step: number;
  totalSteps: number;
  title: string;
  description?: string;
  children: React.ReactNode;
}

export const StepContainer: React.FC<StepContainerProps> = ({
  step,
  totalSteps,
  title,
  description,
  children,
}) => {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text dimColor>
          [{step}/{totalSteps}]
        </Text>
        <Text> </Text>
        <Text bold color="cyan">
          {title}
        </Text>
      </Box>

      {/* Description */}
      {description && (
        <Box marginBottom={1}>
          <Text dimColor>{description}</Text>
        </Box>
      )}

      {/* Separator */}
      <Box marginBottom={1}>
        <Text dimColor>{'─'.repeat(50)}</Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
};
