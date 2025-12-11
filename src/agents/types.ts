export type AgentStatus = 'idle' | 'assigned' | 'working' | 'completed' | 'failed' | 'retrying';

export interface AgentState {
  id: string;
  status: AgentStatus;
  ticketId: string | null;
  ticketIdentifier: string | null;
  worktreePath: string | null;
  branchName: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  retryCount: number;
  lastError: string | null;
  processId: number | null;
}

export interface AgentResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  output?: string;
}

export interface WorkAssignment {
  ticketId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  ticketDescription: string;
  ticketUrl: string;
}
