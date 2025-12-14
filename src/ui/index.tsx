import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';
import type { LogEntry } from './components/LogPane.js';
import type { AgentInfo } from './components/AgentPane.js';

// Agent state getter - will be set by the pool
type AgentStateGetter = () => { agents: AgentInfo[]; available: number; total: number };
let getAgentState: AgentStateGetter | null = null;

export function setAgentStateGetter(getter: AgentStateGetter): void {
  getAgentState = getter;
}

class InkTerminalUI {
  private logBuffer: LogEntry[] = [];
  private maxLogs = 50; // Increased for better scrollback
  private rateLimitResetAt: Date | null = null;
  private inkInstance: { clear: () => void; unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  start(): void {
    if (this.inkInstance) {
      return; // Already started
    }

    // Render the Ink app
    this.inkInstance = render(
      <App
        getLogs={() => this.logBuffer}
        getAgentState={() => getAgentState?.() ?? { agents: [], available: 0, total: 5 }}
        getRateLimitResetAt={() => this.rateLimitResetAt}
      />
    );
  }

  log(level: LogEntry['level'], message: string, module?: string): void {
    this.logBuffer.push({
      timestamp: new Date(),
      level,
      message: message.replace(/\n/g, ' ').substring(0, 200),
      module,
    });

    // Keep buffer size limited
    if (this.logBuffer.length > this.maxLogs) {
      this.logBuffer.shift();
    }
  }

  setRateLimitStatus(resetAt: Date | null): void {
    this.rateLimitResetAt = resetAt;
  }

  stop(): void {
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
  }
}

export const terminalUI = new InkTerminalUI();

// Helper function for logging that integrates with the UI
export function logToUI(level: LogEntry['level'], message: string, module?: string): void {
  terminalUI.log(level, message, module);
}

// Re-export types for compatibility
export type { LogEntry, AgentInfo };
