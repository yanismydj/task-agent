// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

const c = colors;

const LOGO = `
${c.cyan}${c.bold}  ████████╗ █████╗ ███████╗██╗  ██╗
  ╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
     ██║   ███████║███████╗█████╔╝
     ██║   ██╔══██║╚════██║██╔═██╗
     ██║   ██║  ██║███████║██║  ██╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ${c.dim}${c.white}═══════════════════════════════════${c.reset}
  ${c.cyan}${c.bold}     A G E N T${c.reset}  ${c.dim}v0.1.0${c.reset}
`;

const DIVIDER = `${c.dim}${'─'.repeat(50)}${c.reset}`;
const THIN_DIVIDER = `${c.dim}${'·'.repeat(50)}${c.reset}`;

interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'success' | 'debug';
  message: string;
  module?: string;
}

interface AgentInfo {
  id: string;
  ticketIdentifier: string;
  status: string;
  startedAt: Date;
}

// Agent state getter - will be set by the pool
type AgentStateGetter = () => { agents: AgentInfo[]; available: number; total: number };
let getAgentState: AgentStateGetter | null = null;

export function setAgentStateGetter(getter: AgentStateGetter): void {
  getAgentState = getter;
}

class TerminalUI {
  private logBuffer: LogEntry[] = [];
  private maxLogs = 15;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private lastRender = '';
  private startTime = new Date();

  start(): void {
    // Clear screen and hide cursor
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');

    // Print logo once
    console.log(LOGO);

    // Start refresh loop
    this.refreshInterval = setInterval(() => this.render(), 500);

    // Handle exit
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  private cleanup(): void {
    // Show cursor again
    process.stdout.write('\x1b[?25h');
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  log(level: LogEntry['level'], message: string, module?: string): void {
    this.logBuffer.push({
      timestamp: new Date(),
      level,
      message: message.replace(/\n/g, ' ').substring(0, 100),
      module,
    });

    // Keep buffer size limited
    if (this.logBuffer.length > this.maxLogs) {
      this.logBuffer.shift();
    }
  }

  private render(): void {
    const output = this.buildOutput();

    // Only redraw if something changed
    if (output === this.lastRender) return;
    this.lastRender = output;

    // Move cursor to after logo and clear rest of screen
    process.stdout.write('\x1b[10;0H\x1b[J');
    process.stdout.write(output);
  }

  private buildOutput(): string {
    const lines: string[] = [];

    // Agent status section
    lines.push(this.buildAgentSection());
    lines.push('');

    // Activity log section
    lines.push(this.buildLogSection());

    // Status bar
    lines.push('');
    lines.push(this.buildStatusBar());

    return lines.join('\n');
  }

  private buildAgentSection(): string {
    const lines: string[] = [];

    lines.push(`${c.bold}${c.white}  AGENTS${c.reset}`);
    lines.push(DIVIDER);

    const state = getAgentState ? getAgentState() : { agents: [], available: 0, total: 5 };
    const { agents, available, total } = state;

    if (agents.length === 0) {
      lines.push(`  ${c.dim}No active agents${c.reset}  ${c.green}●${c.reset} ${available}/${total} available`);
    } else {
      // Show active agents
      for (const agent of agents) {
        const runtime = this.formatDuration(Date.now() - agent.startedAt.getTime());
        const statusIcon = this.getStatusIcon(agent.status);
        const ticket = agent.ticketIdentifier || 'Unknown';

        lines.push(
          `  ${statusIcon} ${c.bold}${ticket}${c.reset} ${c.dim}│${c.reset} ` +
          `${c.cyan}${agent.status}${c.reset} ${c.dim}│${c.reset} ${runtime}`
        );
      }

      lines.push(THIN_DIVIDER);
      lines.push(`  ${c.green}●${c.reset} ${available}/${total} slots available`);
    }

    return lines.join('\n');
  }

  private buildLogSection(): string {
    const lines: string[] = [];

    lines.push(`${c.bold}${c.white}  ACTIVITY${c.reset}`);
    lines.push(DIVIDER);

    if (this.logBuffer.length === 0) {
      lines.push(`  ${c.dim}Waiting for activity...${c.reset}`);
    } else {
      for (const entry of this.logBuffer.slice(-this.maxLogs)) {
        const time = this.formatTime(entry.timestamp);
        const levelIcon = this.getLevelIcon(entry.level);
        const module = entry.module ? `${c.dim}[${entry.module}]${c.reset} ` : '';

        lines.push(`  ${c.dim}${time}${c.reset} ${levelIcon} ${module}${entry.message}`);
      }
    }

    return lines.join('\n');
  }

  private buildStatusBar(): string {
    const uptime = this.formatDuration(Date.now() - this.startTime.getTime());
    const time = new Date().toLocaleTimeString();

    return `${c.dim}  ⏱ Uptime: ${uptime}  │  🕐 ${time}  │  Press Ctrl+C to exit${c.reset}`;
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'working': return `${c.yellow}◉${c.reset}`;
      case 'completed': return `${c.green}✓${c.reset}`;
      case 'failed': return `${c.red}✗${c.reset}`;
      case 'assigned': return `${c.blue}○${c.reset}`;
      default: return `${c.dim}○${c.reset}`;
    }
  }

  private getLevelIcon(level: LogEntry['level']): string {
    switch (level) {
      case 'info': return `${c.blue}ℹ${c.reset}`;
      case 'success': return `${c.green}✓${c.reset}`;
      case 'warn': return `${c.yellow}⚠${c.reset}`;
      case 'error': return `${c.red}✗${c.reset}`;
      case 'debug': return `${c.dim}●${c.reset}`;
      default: return ' ';
    }
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  private formatDuration(ms: number): string {
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
  }

  stop(): void {
    this.cleanup();
  }
}

export const terminalUI = new TerminalUI();

// Helper function for logging that integrates with the UI
export function logToUI(level: LogEntry['level'], message: string, module?: string): void {
  terminalUI.log(level, message, module);
}
