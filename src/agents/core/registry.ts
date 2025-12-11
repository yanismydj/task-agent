import { createChildLogger } from '../../utils/logger.js';
import type { Agent, AgentType } from './types.js';

const logger = createChildLogger({ module: 'agent-registry' });

export class AgentRegistry {
  private agents: Map<AgentType, Agent<unknown, unknown>> = new Map();
  private static instance: AgentRegistry | null = null;

  private constructor() {}

  static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) {
      AgentRegistry.instance = new AgentRegistry();
    }
    return AgentRegistry.instance;
  }

  static resetInstance(): void {
    AgentRegistry.instance = null;
  }

  register<TI, TO>(agent: Agent<TI, TO>): void {
    if (this.agents.has(agent.config.type)) {
      logger.warn({ type: agent.config.type }, 'Agent already registered, replacing');
    }
    this.agents.set(agent.config.type, agent as Agent<unknown, unknown>);
    logger.info(
      { type: agent.config.type, name: agent.config.name },
      'Agent registered'
    );
  }

  get<TI, TO>(type: AgentType): Agent<TI, TO> {
    const agent = this.agents.get(type);
    if (!agent) {
      throw new Error(`Agent '${type}' not found in registry`);
    }
    return agent as Agent<TI, TO>;
  }

  has(type: AgentType): boolean {
    return this.agents.has(type);
  }

  getAll(): Agent<unknown, unknown>[] {
    return Array.from(this.agents.values());
  }

  getAllTypes(): AgentType[] {
    return Array.from(this.agents.keys());
  }

  getAgentInfo(): Array<{ type: AgentType; name: string; modelTier: string; cacheable: boolean }> {
    return this.getAll().map((agent) => ({
      type: agent.config.type,
      name: agent.config.name,
      modelTier: agent.config.modelTier,
      cacheable: agent.config.cacheable,
    }));
  }

  clear(): void {
    this.agents.clear();
    logger.info('Agent registry cleared');
  }
}

export const agentRegistry = AgentRegistry.getInstance();
