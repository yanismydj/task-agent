import { z } from 'zod';

export type AgentType =
  | 'readiness-scorer'
  | 'ticket-refiner'
  | 'prompt-generator'
  | 'code-executor'
  | 'planner'
  | 'plan-consolidator'
  | 'plan-question-extractor';

export type ModelTier = 'fast' | 'standard' | 'advanced';

export interface AgentConfig {
  type: AgentType;
  name: string;
  description: string;
  modelTier: ModelTier;
  cacheable: boolean;
  maxConcurrent?: number;
  timeoutMs?: number;
}

export interface AgentInput<T = unknown> {
  ticketId: string;
  ticketIdentifier: string;
  data: T;
  context?: Record<string, unknown>;
}

export interface AgentMetadata {
  modelUsed: string;
  tokenCount?: number;
  durationMs: number;
  cached: boolean;
}

export interface AgentOutput<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: AgentMetadata;
}

export interface Agent<TInput = unknown, TOutput = unknown> {
  readonly config: AgentConfig;
  readonly inputSchema: z.ZodSchema<TInput>;
  readonly outputSchema: z.ZodSchema<TOutput>;

  execute(input: AgentInput<TInput>): Promise<AgentOutput<TOutput>>;
  validateInput(input: unknown): TInput;
  getCacheKey?(input: AgentInput<TInput>): string;
}

// Readiness Scorer schemas
export const ReadinessScorerInputSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number(),
  labels: z.array(z.object({ name: z.string() })),
  state: z.object({ name: z.string(), type: z.string() }),
  comments: z.array(z.object({
    body: z.string(),
    createdAt: z.date(),
    userId: z.string().optional(),
  })).optional(),
});

export type ReadinessScorerInput = z.infer<typeof ReadinessScorerInputSchema>;

export const ReadinessScorerOutputSchema = z.object({
  ready: z.boolean(),
  score: z.number().min(0).max(100),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
  reasoning: z.string(),
  recommendedAction: z.enum(['execute', 'refine', 'block', 'skip']),
});

export type ReadinessScorerOutput = z.infer<typeof ReadinessScorerOutputSchema>;

// Ticket Refiner schemas
export const TicketRefinerInputSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  readinessResult: ReadinessScorerOutputSchema,
  existingComments: z.array(z.object({
    body: z.string(),
    isFromTaskAgent: z.boolean(),
    createdAt: z.date(),
  })),
  codebaseContext: z.string().optional(),
  // When true, MUST ask clarifying questions regardless of readiness score
  // Used when user explicitly requests clarification via "clarify" label
  forceAskQuestions: z.boolean().optional(),
});

export type TicketRefinerInput = z.infer<typeof TicketRefinerInputSchema>;

export const TicketRefinerOutputSchema = z.object({
  action: z.enum(['ask_questions', 'suggest_improvements', 'ready', 'blocked']),
  questions: z.array(z.object({
    question: z.string(),
    options: z.array(z.string()), // Multiple choice options, empty for open-ended
    allowMultiple: z.boolean(), // Can select multiple options?
    priority: z.enum(['critical', 'important', 'nice_to_have']),
  })),
  suggestedDescription: z.string().optional(),
  suggestedAcceptanceCriteria: z.array(z.string()),
  blockerReason: z.string().optional(),
});

export type TicketRefinerOutput = z.infer<typeof TicketRefinerOutputSchema>;

// Prompt Generator schemas
export const PromptGeneratorInputSchema = z.object({
  ticket: z.object({
    identifier: z.string(),
    title: z.string(),
    description: z.string(),
    url: z.string(),
    acceptanceCriteria: z.array(z.string()).optional(),
    attachments: z.array(z.object({
      id: z.string(),
      title: z.string().nullable(),
      url: z.string(),
      localPath: z.string().optional(),
    })).optional(),
  }),
  codebaseInfo: z.object({
    relevantFiles: z.array(z.string()),
    patterns: z.array(z.string()),
    conventions: z.string(),
  }).optional(),
  constraints: z.object({
    maxFiles: z.number().optional(),
    testRequirements: z.string().optional(),
    branchNaming: z.string(),
  }),
  // Optional restart context for when work is restarted after previous attempts
  restartContext: z.object({
    previousAttemptCount: z.number(),
    previousStatus: z.enum(['failed', 'completed', 'interrupted']),
    newComments: z.array(z.object({
      body: z.string(),
      createdAt: z.date(),
      isFromUser: z.boolean(),
    })),
    summary: z.string(), // Summary of what was attempted before
  }).optional(),
  // Optional planning Q&A conversation from planning mode
  planningQAndA: z.array(z.object({
    body: z.string(),
    isFromTaskAgent: z.boolean(),
    createdAt: z.date(),
  })).optional(),
});

export type PromptGeneratorInput = z.infer<typeof PromptGeneratorInputSchema>;

export const PromptGeneratorOutputSchema = z.object({
  prompt: z.string(),
  suggestedFiles: z.array(z.string()),
  estimatedComplexity: z.enum(['simple', 'moderate', 'complex']),
  warnings: z.array(z.string()),
});

export type PromptGeneratorOutput = z.infer<typeof PromptGeneratorOutputSchema>;

// Code Executor schemas
export const CodeExecutorInputSchema = z.object({
  ticketIdentifier: z.string(),
  prompt: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
});

export type CodeExecutorInput = z.infer<typeof CodeExecutorInputSchema>;

export const CodeExecutorOutputSchema = z.object({
  success: z.boolean(),
  prUrl: z.string().optional(),
  commitSha: z.string().optional(),
  filesModified: z.array(z.string()),
  testResults: z.object({
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }).optional(),
  error: z.string().optional(),
  output: z.string(),
});

export type CodeExecutorOutput = z.infer<typeof CodeExecutorOutputSchema>;
