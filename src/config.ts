import { z } from 'zod';
import { config as loadEnv } from 'dotenv';

loadEnv();

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
  }),
  github: z.object({
    repo: z.string().min(1, 'GITHUB_REPO is required (format: owner/repo)'),
  }),
  anthropic: z.object({
    apiKey: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
    model: z.string().default('claude-sonnet-4-5'),
  }),
  agents: z.object({
    maxConcurrent: z.number().int().min(1).max(20).default(5),
    workDir: z.string().min(1, 'AGENTS_WORK_DIR is required'),
    timeoutMinutes: z.number().int().min(1).default(60),
    maxRetries: z.number().int().min(0).default(2),
  }),
  daemon: z.object({
    pollIntervalSeconds: z.number().int().min(5).default(30),
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
      projectId: process.env['LINEAR_PROJECT_ID'] || undefined,
    },
    github: {
      repo: process.env['GITHUB_REPO'] ?? '',
    },
    anthropic: {
      apiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
      model: process.env['ANTHROPIC_MODEL'] || 'claude-sonnet-4-5',
    },
    agents: {
      maxConcurrent: parseInt(process.env['AGENTS_MAX_CONCURRENT'] || '5', 10),
      workDir: process.env['AGENTS_WORK_DIR'] ?? '',
      timeoutMinutes: parseInt(process.env['AGENTS_TIMEOUT_MINUTES'] || '60', 10),
      maxRetries: parseInt(process.env['AGENTS_MAX_RETRIES'] || '2', 10),
    },
    daemon: {
      pollIntervalSeconds: parseInt(process.env['DAEMON_POLL_INTERVAL_SECONDS'] || '30', 10),
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
