import { z } from 'zod';
import { config as loadEnv } from 'dotenv';

loadEnv();

// UUID validation helper
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_REGEX.test(value);
}

// Linear auth can be either OAuth (preferred for agents) or API key (legacy)
const LinearAuthSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('oauth'),
    clientId: z.string().min(1, 'LINEAR_CLIENT_ID is required for OAuth mode'),
    clientSecret: z.string().min(1, 'LINEAR_CLIENT_SECRET is required for OAuth mode'),
  }),
  z.object({
    mode: z.literal('apikey'),
    apiKey: z.string().min(1, 'LINEAR_API_KEY is required for API key mode'),
  }),
]);

const ConfigSchema = z.object({
  linear: z.object({
    auth: LinearAuthSchema,
    teamId: z.string().min(1, 'LINEAR_TEAM_ID is required'),
    projectId: z.string().optional(),
    webhookSecret: z.string().optional(), // For verifying webhook signatures
  }),
  webhook: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(4847),
    allowUnsigned: z.boolean().default(false), // Only for development - allows unsigned webhooks
  }),
  isDevelopment: z.boolean().default(false),
  github: z.object({
    repo: z.string().min(1, 'GITHUB_REPO is required (format: owner/repo)'),
  }),
  anthropic: z.object({
    apiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
    model: z.string().default('claude-sonnet-4-5'),
  }),
  agents: z.object({
    maxConcurrent: z.number().int().min(1).max(20).default(5),
    maxCodeExecutors: z.number().int().min(0).max(10).default(2), // 0 = Linear analysis only, no Claude Code execution
    workDir: z.string().min(1, 'AGENTS_WORK_DIR is required'),
    timeoutMinutes: z.number().int().min(1).default(60),
    maxRetries: z.number().int().min(0).default(2),
    readinessThreshold: z.number().int().min(0).max(100).default(70),
    models: z.object({
      // Claude 4.5 models required for structured outputs beta
      fast: z.string().default('claude-haiku-4-5-20251001'),
      standard: z.string().default('claude-sonnet-4-5-20250929'),
      advanced: z.string().default('claude-opus-4-5-20251101'),
    }),
  }),
  daemon: z.object({
    pollIntervalSeconds: z.number().int().min(5).default(30),
  }),
  debug: z.object({
    enabled: z.boolean().default(false),
    cachePromptsDir: z.string().default('.task-agent/cached-prompts'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LinearAuth = z.infer<typeof LinearAuthSchema>;

function loadConfig(): Config {
  // Determine Linear auth mode based on env vars
  const hasOAuth = process.env['LINEAR_CLIENT_ID'] && process.env['LINEAR_CLIENT_SECRET'];
  const hasApiKey = process.env['LINEAR_API_KEY'];

  let linearAuth: LinearAuth;
  if (hasOAuth) {
    linearAuth = {
      mode: 'oauth',
      clientId: process.env['LINEAR_CLIENT_ID']!,
      clientSecret: process.env['LINEAR_CLIENT_SECRET']!,
    };
  } else if (hasApiKey) {
    linearAuth = {
      mode: 'apikey',
      apiKey: process.env['LINEAR_API_KEY']!,
    };
  } else {
    throw new Error(
      'Linear authentication required. Set either LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET (OAuth, recommended) or LINEAR_API_KEY (legacy).'
    );
  }

  const rawConfig = {
    linear: {
      auth: linearAuth,
      teamId: process.env['LINEAR_TEAM_ID'] ?? '',
      projectId: isValidUuid(process.env['LINEAR_PROJECT_ID']) ? process.env['LINEAR_PROJECT_ID'] : undefined,
      webhookSecret: process.env['LINEAR_WEBHOOK_SECRET'] || undefined,
    },
    webhook: {
      enabled: process.env['WEBHOOK_ENABLED'] === 'true',
      port: parseInt(process.env['WEBHOOK_PORT'] || '4847', 10),
      allowUnsigned: process.env['WEBHOOK_ALLOW_UNSIGNED'] === 'true',
    },
    isDevelopment: process.env['NODE_ENV'] !== 'production',
    github: {
      repo: process.env['GITHUB_REPO'] ?? '',
    },
    anthropic: {
      apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
      model: process.env['ANTHROPIC_MODEL'] || 'claude-sonnet-4-5',
    },
    agents: {
      maxConcurrent: parseInt(process.env['AGENTS_MAX_CONCURRENT'] || '5', 10),
      maxCodeExecutors: parseInt(process.env['AGENTS_MAX_CODE_EXECUTORS'] || '2', 10),
      workDir: process.env['AGENTS_WORK_DIR'] ?? '',
      timeoutMinutes: parseInt(process.env['AGENTS_TIMEOUT_MINUTES'] || '60', 10),
      maxRetries: parseInt(process.env['AGENTS_MAX_RETRIES'] || '2', 10),
      readinessThreshold: parseInt(process.env['AGENTS_READINESS_THRESHOLD'] || '70', 10),
      models: {
        fast: process.env['AGENTS_MODEL_FAST'] || 'claude-haiku-4-5-20251001',
        standard: process.env['AGENTS_MODEL_STANDARD'] || 'claude-sonnet-4-5-20250929',
        advanced: process.env['AGENTS_MODEL_ADVANCED'] || 'claude-opus-4-5-20251101',
      },
    },
    daemon: {
      pollIntervalSeconds: parseInt(process.env['DAEMON_POLL_INTERVAL_SECONDS'] || '30', 10),
    },
    debug: {
      enabled: process.env['DEBUG_MODE'] === 'true',
      cachePromptsDir: process.env['DEBUG_CACHE_PROMPTS_DIR'] || '.task-agent/cached-prompts',
    },
  };

  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}

export const config = loadConfig();
