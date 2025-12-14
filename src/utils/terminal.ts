// ANSI color codes
// Using both standard and bright variants for better visibility across themes
// Standard colors (30-37) work well in dark themes
// Bright colors (90-97) provide better contrast in both dark and light themes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Standard colors (work best in dark themes)
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright/bold colors (better visibility in both dark and light themes)
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',

  // Semantic colors for log levels (designed to work in both dark and light themes)
  // These provide consistent, accessible styling across terminal environments
  errorColor: '\x1b[91m\x1b[1m',      // Bright red + bold - highly visible for critical issues
  warnColor: '\x1b[93m',              // Bright yellow - noticeable but not alarming
  infoColor: '\x1b[96m',              // Bright cyan - clear and readable
  successColor: '\x1b[92m',           // Bright green - positive feedback
};

const c = colors;

const LOGO = `
${c.brightCyan}${c.bold}  ████████╗ █████╗ ███████╗██╗  ██╗
  ╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
     ██║   ███████║███████╗█████╔╝
     ██║   ██╔══██║╚════██║██╔═██╗
     ██║   ██║  ██║███████║██║  ██╗
     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  ${c.dim}═══════════════════════════════════${c.reset}
  ${c.brightCyan}${c.bold}     A G E N T${c.reset}  ${c.dim}v0.1.0${c.reset}
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
  recentOutput: string[];
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
  private rateLimitResetAt: Date | null = null;

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

  setRateLimitStatus(resetAt: Date | null): void {
    this.rateLimitResetAt = resetAt;
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

    // Rate limit warning banner (if active)
    const rateLimitBanner = this.buildRateLimitBanner();
    if (rateLimitBanner) {
      lines.push(rateLimitBanner);
      lines.push('');
    }

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

  private buildRateLimitBanner(): string | null {
    if (!this.rateLimitResetAt) return null;

    const now = new Date();
    if (now >= this.rateLimitResetAt) {
      this.rateLimitResetAt = null;
      return null;
    }

    const resetTime = this.rateLimitResetAt.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    return `${c.bgYellow}${c.black}${c.bold}  ⚠  Linear rate limit hit - paused until ${resetTime}  ${c.reset}`;
  }

  private buildAgentSection(): string {
    const lines: string[] = [];

    const state = getAgentState ? getAgentState() : { agents: [], available: 0, total: 5 };
    const { agents, available, total } = state;

    if (agents.length === 0) {
      lines.push(`${c.bold}${c.brightCyan}  CLAUDE CODE${c.reset}`);
      lines.push(DIVIDER);
      lines.push(`  ${c.dim}No active sessions${c.reset}  ${c.successColor}●${c.reset} ${available}/${total} slots available`);
    } else {
      lines.push(`${c.bold}${c.brightCyan}  CLAUDE CODE OUTPUT${c.reset}`);
      lines.push(DIVIDER);

      // Show active agents with their recent output
      for (const agent of agents) {
        const runtime = this.formatDuration(Date.now() - agent.startedAt.getTime());
        const statusIcon = this.getStatusIcon(agent.status);
        const ticket = agent.ticketIdentifier || 'Unknown';

        lines.push(
          `  ${statusIcon} ${c.bold}${c.brightWhite}${ticket}${c.reset} ${c.dim}│${c.reset} ` +
          `${c.brightCyan}${agent.status}${c.reset} ${c.dim}│${c.reset} ${c.dim}${runtime}${c.reset}`
        );

        // Show recent Claude Code output (indented)
        if (agent.recentOutput.length > 0) {
          for (const outputLine of agent.recentOutput) {
            const truncated = outputLine.length > 70 ? outputLine.slice(0, 67) + '...' : outputLine;
            lines.push(`     ${c.dim}│${c.reset} ${truncated}`);
          }
        } else {
          lines.push(`     ${c.dim}│ Waiting for output...${c.reset}`);
        }
        lines.push('');
      }

      lines.push(THIN_DIVIDER);
      lines.push(`  ${c.successColor}●${c.reset} ${available}/${total} slots available`);
    }

    return lines.join('\n');
  }

  private buildLogSection(): string {
    const lines: string[] = [];

    lines.push(`${c.bold}${c.brightWhite}  ACTIVITY${c.reset}`);
    lines.push(DIVIDER);

    if (this.logBuffer.length === 0) {
      lines.push(`  ${c.dim}Waiting for activity...${c.reset}`);
    } else {
      for (const entry of this.logBuffer.slice(-this.maxLogs)) {
        const time = this.formatTime(entry.timestamp);
        const levelIcon = this.getLevelIcon(entry.level);
        const module = entry.module ? `${c.dim}[${entry.module}]${c.reset} ` : '';

        // Apply color to message based on log level for better visual hierarchy
        const coloredMessage = this.colorizeMessage(entry.message, entry.level);

        lines.push(`  ${c.dim}${time}${c.reset} ${levelIcon} ${module}${coloredMessage}`);
      }
    }

    return lines.join('\n');
  }

  private colorizeMessage(message: string, level: LogEntry['level']): string {
    // Apply subtle coloring to message text based on level
    // This enhances visual hierarchy while maintaining readability
    switch (level) {
      case 'error': return `${c.errorColor}${message}${c.reset}`;
      case 'warn': return `${c.warnColor}${message}${c.reset}`;
      case 'info': return `${c.white}${message}${c.reset}`;
      case 'success': return `${c.successColor}${message}${c.reset}`;
      case 'debug': return `${c.dim}${message}${c.reset}`;
      default: return message;
    }
  }

  private buildStatusBar(): string {
    const uptime = this.formatDuration(Date.now() - this.startTime.getTime());
    const time = new Date().toLocaleTimeString();

    return `${c.dim}  ⏱ Uptime: ${uptime}  │  🕐 ${time}  │  Press Ctrl+C to exit${c.reset}`;
  }

  private getStatusIcon(status: string): string {
    // Enhanced status icons with bright colors for better visibility
    switch (status) {
      case 'working': return `${c.brightYellow}◉${c.reset}`;
      case 'completed': return `${c.successColor}✓${c.reset}`;
      case 'failed': return `${c.errorColor}✗${c.reset}`;
      case 'assigned': return `${c.brightBlue}○${c.reset}`;
      default: return `${c.dim}○${c.reset}`;
    }
  }

  private getLevelIcon(level: LogEntry['level']): string {
    // Enhanced styling with semantic colors and bold emphasis
    // Icons are chosen for readability and universal terminal support
    switch (level) {
      case 'info': return `${c.infoColor}●${c.reset}`;           // Bright cyan circle
      case 'success': return `${c.successColor}✓${c.reset}`;     // Bright green checkmark
      case 'warn': return `${c.warnColor}▲${c.reset}`;           // Bright yellow triangle (more visible than ⚠)
      case 'error': return `${c.errorColor}✖${c.reset}`;         // Bright red + bold X (highly visible)
      case 'debug': return `${c.dim}●${c.reset}`;                // Unchanged: dim circle
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
