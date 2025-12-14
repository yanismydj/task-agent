import React from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { SplashScreen } from './SplashScreen.js';
import { LogPane, type LogEntry } from './LogPane.js';
import { AgentPane, type AgentInfo } from './AgentPane.js';
import { StatusBar } from './StatusBar.js';

interface AppProps {
  getLogs: () => LogEntry[];
  getAgentState: () => { agents: AgentInfo[]; available: number; total: number };
  getRateLimitResetAt: () => Date | null;
}

export const App: React.FC<AppProps> = ({ getLogs, getAgentState, getRateLimitResetAt }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [showSplash, setShowSplash] = React.useState(true);
  const [startTime] = React.useState(new Date());
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

  // Get terminal dimensions
  const terminalHeight = stdout?.rows ?? 24;

  // Handle Ctrl+C gracefully
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
  });

  // Splash screen timer
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setShowSplash(false);
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  // Refresh UI periodically
  React.useEffect(() => {
    if (!showSplash) {
      const interval = setInterval(() => {
        forceUpdate();
      }, 500);

      return () => clearInterval(interval);
    }
    return undefined;
  }, [showSplash]);

  if (showSplash) {
    return <SplashScreen />;
  }

  const logs = getLogs();
  const agentState = getAgentState();
  const rateLimitResetAt = getRateLimitResetAt();

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Rate limit banner */}
      {rateLimitResetAt && new Date() < rateLimitResetAt && (
        <Box
          backgroundColor="yellow"
          paddingX={1}
          marginBottom={1}
        >
          <Text color="black" bold>
            ⚠  Linear rate limit hit - paused until {rateLimitResetAt.toLocaleTimeString('en-US', {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </Box>
      )}

      {/* Split pane layout */}
      <Box flexGrow={1}>
        {/* Left pane: TaskAgent logs */}
        <Box width="50%" borderStyle="single" borderColor="gray">
          <LogPane title="TASKAGENT ACTIVITY" logs={logs} maxLines={20} />
        </Box>

        {/* Right pane: Claude Code output */}
        <Box width="50%" borderStyle="single" borderColor="gray">
          <AgentPane
            agents={agentState.agents}
            available={agentState.available}
            total={agentState.total}
          />
        </Box>
      </Box>

      {/* Status bar */}
      <StatusBar startTime={startTime} />
    </Box>
  );
};
