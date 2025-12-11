/**
 * Workflow states and transitions for ticket processing
 */

export type TicketWorkflowState =
  | 'new'
  | 'evaluating'
  | 'needs_refinement'
  | 'refining'
  | 'awaiting_response'
  | 'ready_for_approval'
  | 'approved'
  | 'generating_prompt'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'blocked';

export const VALID_TRANSITIONS: Record<TicketWorkflowState, TicketWorkflowState[]> = {
  new: ['evaluating'],
  evaluating: ['needs_refinement', 'ready_for_approval', 'blocked'],
  needs_refinement: ['refining'],
  refining: ['awaiting_response', 'ready_for_approval'],
  awaiting_response: ['evaluating'], // Re-evaluate after human response
  ready_for_approval: ['approved', 'needs_refinement'],
  approved: ['generating_prompt'],
  generating_prompt: ['executing', 'failed'],
  executing: ['completed', 'failed', 'executing'], // Retry allowed
  completed: [],
  failed: ['new'], // Can restart
  blocked: ['new'], // Can unblock and restart
};

export const LINEAR_LABELS: Record<TicketWorkflowState, string | null> = {
  new: null,
  evaluating: 'ta:evaluating',
  needs_refinement: 'ta:needs-refinement',
  refining: 'ta:refining',
  awaiting_response: 'ta:awaiting-response',
  ready_for_approval: 'ta:pending-approval',
  approved: 'ta:approved',
  generating_prompt: 'ta:generating-prompt',
  executing: 'task-agent',
  completed: 'ta:completed',
  failed: 'ta:failed',
  blocked: 'ta:blocked',
};

export interface StateTransitionEvent {
  from: TicketWorkflowState;
  to: TicketWorkflowState;
  ticketId: string;
  ticketIdentifier: string;
  timestamp: Date;
  reason?: string;
  agentOutput?: unknown;
}

export function isValidTransition(from: TicketWorkflowState, to: TicketWorkflowState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function getNextStates(state: TicketWorkflowState): TicketWorkflowState[] {
  return VALID_TRANSITIONS[state];
}

export function isTerminalState(state: TicketWorkflowState): boolean {
  return state === 'completed' || state === 'blocked';
}

export function requiresHumanInput(state: TicketWorkflowState): boolean {
  return state === 'awaiting_response' || state === 'ready_for_approval';
}

export function isActiveState(state: TicketWorkflowState): boolean {
  return ['evaluating', 'refining', 'generating_prompt', 'executing'].includes(state);
}
