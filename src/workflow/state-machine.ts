import { createChildLogger } from '../utils/logger.js';
import {
  type TicketWorkflowState,
  type StateTransitionEvent,
  isValidTransition,
  isTerminalState,
} from './states.js';

const logger = createChildLogger({ module: 'state-machine' });

export interface TicketState {
  ticketId: string;
  ticketIdentifier: string;
  currentState: TicketWorkflowState;
  history: StateTransitionEvent[];
  agentOutputs: Map<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface TransitionResult {
  success: boolean;
  previousState: TicketWorkflowState;
  newState: TicketWorkflowState;
  error?: string;
}

export class TicketStateMachine {
  private tickets: Map<string, TicketState> = new Map();

  initializeTicket(
    ticketId: string,
    ticketIdentifier: string,
    initialState: TicketWorkflowState = 'new'
  ): TicketState {
    if (this.tickets.has(ticketId)) {
      const existing = this.tickets.get(ticketId)!;
      logger.debug({ ticketId: ticketIdentifier }, 'Ticket already initialized');
      return existing;
    }

    const state: TicketState = {
      ticketId,
      ticketIdentifier,
      currentState: initialState,
      history: [],
      agentOutputs: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    };

    this.tickets.set(ticketId, state);
    logger.info({ ticketId: ticketIdentifier, initialState }, 'Ticket state initialized');

    return state;
  }

  getState(ticketId: string): TicketState | undefined {
    return this.tickets.get(ticketId);
  }

  getCurrentState(ticketId: string): TicketWorkflowState | undefined {
    return this.tickets.get(ticketId)?.currentState;
  }

  transition(
    ticketId: string,
    to: TicketWorkflowState,
    reason?: string,
    agentOutput?: unknown
  ): TransitionResult {
    const ticket = this.tickets.get(ticketId);

    if (!ticket) {
      return {
        success: false,
        previousState: 'new',
        newState: 'new',
        error: `Ticket ${ticketId} not found in state machine`,
      };
    }

    const from = ticket.currentState;

    if (!isValidTransition(from, to)) {
      logger.warn(
        { ticketId: ticket.ticketIdentifier, from, to },
        'Invalid state transition attempted'
      );
      return {
        success: false,
        previousState: from,
        newState: from,
        error: `Invalid transition from ${from} to ${to}`,
      };
    }

    // Record the transition
    const event: StateTransitionEvent = {
      from,
      to,
      ticketId,
      ticketIdentifier: ticket.ticketIdentifier,
      timestamp: new Date(),
      reason,
      agentOutput,
    };

    ticket.history.push(event);
    ticket.currentState = to;
    ticket.updatedAt = new Date();

    if (agentOutput) {
      ticket.agentOutputs.set(`${to}-${Date.now()}`, agentOutput);
    }

    logger.info(
      { ticketId: ticket.ticketIdentifier, from, to, reason },
      'State transition completed'
    );

    return {
      success: true,
      previousState: from,
      newState: to,
    };
  }

  setMetadata(ticketId: string, key: string, value: unknown): void {
    const ticket = this.tickets.get(ticketId);
    if (ticket) {
      ticket.metadata[key] = value;
      ticket.updatedAt = new Date();
    }
  }

  getMetadata(ticketId: string, key: string): unknown {
    return this.tickets.get(ticketId)?.metadata[key];
  }

  storeAgentOutput(ticketId: string, agentType: string, output: unknown): void {
    const ticket = this.tickets.get(ticketId);
    if (ticket) {
      ticket.agentOutputs.set(agentType, output);
      ticket.updatedAt = new Date();
    }
  }

  getAgentOutput<T>(ticketId: string, agentType: string): T | undefined {
    const ticket = this.tickets.get(ticketId);
    return ticket?.agentOutputs.get(agentType) as T | undefined;
  }

  isTerminal(ticketId: string): boolean {
    const state = this.getCurrentState(ticketId);
    return state ? isTerminalState(state) : false;
  }

  getHistory(ticketId: string): StateTransitionEvent[] {
    return this.tickets.get(ticketId)?.history ?? [];
  }

  removeTicket(ticketId: string): void {
    this.tickets.delete(ticketId);
    logger.debug({ ticketId }, 'Ticket removed from state machine');
  }

  getAllTickets(): TicketState[] {
    return Array.from(this.tickets.values());
  }

  getTicketsByState(state: TicketWorkflowState): TicketState[] {
    return this.getAllTickets().filter((t) => t.currentState === state);
  }

  getActiveTickets(): TicketState[] {
    return this.getAllTickets().filter((t) => !isTerminalState(t.currentState));
  }

  getStats(): Record<TicketWorkflowState, number> {
    const stats: Record<string, number> = {
      new: 0,
      evaluating: 0,
      needs_refinement: 0,
      refining: 0,
      awaiting_response: 0,
      ready_for_approval: 0,
      approved: 0,
      generating_prompt: 0,
      executing: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    };

    for (const ticket of this.tickets.values()) {
      const state = ticket.currentState;
      const current = stats[state];
      if (typeof current === 'number') {
        stats[state] = current + 1;
      }
    }

    return stats as Record<TicketWorkflowState, number>;
  }

  serialize(): string {
    const data = Array.from(this.tickets.entries()).map(([id, state]) => ({
      id,
      ...state,
      agentOutputs: Object.fromEntries(state.agentOutputs),
    }));
    return JSON.stringify(data, null, 2);
  }

  deserialize(json: string): void {
    try {
      const data = JSON.parse(json) as Array<{
        id: string;
        ticketId: string;
        ticketIdentifier: string;
        currentState: TicketWorkflowState;
        history: StateTransitionEvent[];
        agentOutputs: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
        metadata: Record<string, unknown>;
      }>;

      for (const item of data) {
        const state: TicketState = {
          ticketId: item.ticketId,
          ticketIdentifier: item.ticketIdentifier,
          currentState: item.currentState,
          history: item.history.map((h) => ({
            ...h,
            timestamp: new Date(h.timestamp),
          })),
          agentOutputs: new Map(Object.entries(item.agentOutputs)),
          createdAt: new Date(item.createdAt),
          updatedAt: new Date(item.updatedAt),
          metadata: item.metadata,
        };
        this.tickets.set(item.id, state);
      }

      logger.info({ count: data.length }, 'State machine deserialized');
    } catch (error) {
      logger.error({ error }, 'Failed to deserialize state machine');
    }
  }
}

export const ticketStateMachine = new TicketStateMachine();
