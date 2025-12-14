#!/usr/bin/env npx tsx
/**
 * TaskAgent Interactive Setup Script
 *
 * First-time setup wizard that guides users through:
 * - Target repository selection and analysis
 * - Prerequisites check (Node.js, npm)
 * - Creating .env from .env.example
 * - Setting up Linear OAuth application
 * - Configuring API keys and environment variables
 * - Installing dependencies (ngrok)
 * - Running the Linear OAuth flow
 * - Verifying the setup
 *
 * Usage: npm run setup
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execSync, spawn } from 'node:child_process';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const TASKAGENT_DIR = path.join(PROJECT_ROOT, '.taskagent');
const REPO_SUMMARY_PATH = path.join(TASKAGENT_DIR, 'repo-summary.json');
const TOKEN_PATH = path.join(TASKAGENT_DIR, 'token.json');
const LEGACY_REPO_SUMMARY_PATH = path.join(PROJECT_ROOT, '.task-agent-repo-summary.json');
const LEGACY_TOKEN_PATH = path.join(PROJECT_ROOT, '.task-agent-token.json');

// Ensure .taskagent directory exists
function ensureTaskAgentDir(): void {
  if (!fs.existsSync(TASKAGENT_DIR)) {
    fs.mkdirSync(TASKAGENT_DIR, { recursive: true });
  }
}

// Migrate legacy files to new locations
function migrateLegacyFiles(): void {
  ensureTaskAgentDir();

  if (fs.existsSync(LEGACY_REPO_SUMMARY_PATH) && !fs.existsSync(REPO_SUMMARY_PATH)) {
    fs.renameSync(LEGACY_REPO_SUMMARY_PATH, REPO_SUMMARY_PATH);
    console.log(`  ${icons.info} Migrated repo summary to ${REPO_SUMMARY_PATH}`);
  }

  if (fs.existsSync(LEGACY_TOKEN_PATH) && !fs.existsSync(TOKEN_PATH)) {
    fs.renameSync(LEGACY_TOKEN_PATH, TOKEN_PATH);
    console.log(`  ${icons.info} Migrated OAuth token to ${TOKEN_PATH}`);
  }
}

// ANSI colors - using bright variants for better visibility across themes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright colors for better contrast in both dark and light themes
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightRed: '\x1b[91m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

const icons = {
  check: `${colors.brightGreen}✓${colors.reset}`,
  cross: `${colors.brightRed}✗${colors.reset}`,
  arrow: `${colors.brightBlue}→${colors.reset}`,
  warn: `${colors.brightYellow}▲${colors.reset}`,
  info: `${colors.brightCyan}●${colors.reset}`,
};

// Readline interface for prompts
let rl: readline.Interface;

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    // Enhanced prompt with bright blue arrow for better visibility
    rl.question(`${colors.brightCyan}?${colors.reset} ${colors.bold}${question}${colors.reset} `, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptWithDefault(question: string, defaultValue: string): Promise<string> {
  const formattedQuestion = `${question} ${colors.dim}[${defaultValue}]${colors.reset}:`;
  const answer = await prompt(formattedQuestion);
  return answer || defaultValue;
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? `${colors.dim}[Y/n]${colors.reset}` : `${colors.dim}[y/N]${colors.reset}`;
  const formattedQuestion = `${question} ${hint}:`;
  const answer = await prompt(formattedQuestion);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    // Enhanced secret prompt with consistent styling
    stdout.write(`${colors.brightCyan}?${colors.reset} ${colors.bold}${question}${colors.reset} `);

    // Try to hide input
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';

    const onData = (char: string) => {
      // Handle special characters
      if (char === '\n' || char === '\r') {
        stdout.write('\n');
        stdin.removeListener('data', onData);
        if (stdin.isTTY) {
          stdin.setRawMode(false);
        }
        stdin.pause();
        resolve(input);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.exit(1);
      } else if (char === '\u007f' || char === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write('\b \b');
        }
      } else {
        input += char;
        stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

async function waitForEnter(message = 'Press Enter to continue...'): Promise<void> {
  await prompt(`\n${colors.dim}${message}${colors.reset}`);
}

function printHeader(): void {
  console.log(`
${colors.bold}${colors.cyan}╔════════════════════════════════════════════════════════╗
║                                                        ║
║   ${colors.reset}${colors.bold}TaskAgent Setup Wizard${colors.cyan}                              ║
║                                                        ║
║   ${colors.reset}${colors.dim}An assistant PM that keeps coding agents busy${colors.cyan}        ║
║                                                        ║
╚════════════════════════════════════════════════════════╝${colors.reset}
`);
}

function printSection(title: string): void {
  console.log(`\n${colors.bold}${colors.blue}━━━ ${title} ━━━${colors.reset}\n`);
}

function printStep(step: number, total: number, description: string): void {
  console.log(`${colors.dim}[${step}/${total}]${colors.reset} ${description}`);
}

function printSuccess(message: string): void {
  console.log(`${icons.check} ${message}`);
}

function printError(message: string): void {
  console.log(`${icons.cross} ${colors.red}${message}${colors.reset}`);
}

function printWarning(message: string): void {
  console.log(`${icons.warn} ${colors.yellow}${message}${colors.reset}`);
}

function printInfo(message: string): void {
  console.log(`${icons.info} ${message}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Prerequisite Checks
// ═══════════════════════════════════════════════════════════════════════════

function checkNodeVersion(): boolean {
  try {
    const version = process.version;
    const major = parseInt(version.slice(1).split('.')[0], 10);
    if (major >= 20) {
      printSuccess(`Node.js ${version} (requires 20+)`);
      return true;
    } else {
      printError(`Node.js ${version} is too old (requires 20+)`);
      return false;
    }
  } catch {
    printError('Could not determine Node.js version');
    return false;
  }
}

function checkNpmInstalled(): boolean {
  try {
    const version = execSync('npm --version', { encoding: 'utf-8' }).trim();
    printSuccess(`npm ${version}`);
    return true;
  } catch {
    printError('npm not found');
    return false;
  }
}

function checkGitInstalled(): boolean {
  try {
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    printSuccess(version);
    return true;
  } catch {
    printError('git not found');
    return false;
  }
}

function checkNgrokInstalled(): { installed: boolean; authenticated: boolean } {
  try {
    execSync('which ngrok', { encoding: 'utf-8' });
    // Check if authenticated
    try {
      const config = execSync('ngrok config check', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (config.includes('Valid')) {
        printSuccess('ngrok installed and authenticated');
        return { installed: true, authenticated: true };
      }
    } catch {
      // ngrok config check might fail if not authenticated
    }
    printWarning('ngrok installed but may not be authenticated');
    return { installed: true, authenticated: false };
  } catch {
    printWarning('ngrok not installed (optional, needed for webhooks)');
    return { installed: false, authenticated: false };
  }
}

async function checkPrerequisites(): Promise<boolean> {
  printSection('Checking Prerequisites');

  const nodeOk = checkNodeVersion();
  const npmOk = checkNpmInstalled();
  const gitOk = checkGitInstalled();
  const ngrok = checkNgrokInstalled();

  if (!nodeOk || !npmOk || !gitOk) {
    console.log(`\n${icons.cross} Missing required dependencies. Please install them and try again.`);
    return false;
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Environment Setup
// ═══════════════════════════════════════════════════════════════════════════

function loadEnvFile(): Map<string, string> {
  const env = new Map<string, string>();

  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const match = trimmed.match(/^([^=]+)=(.*)$/);
        if (match) {
          env.set(match[1], match[2]);
        }
      }
    }
  }

  return env;
}

function saveEnvFile(env: Map<string, string>): void {
  // Read the template to preserve comments and structure
  let content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');

  // Replace values in template
  for (const [key, value] of env) {
    // Match both KEY=value and KEY= patterns
    const regex = new RegExp(`^(${key})=.*$`, 'm');
    if (content.match(regex)) {
      content = content.replace(regex, `$1=${value}`);
    }
  }

  fs.writeFileSync(ENV_PATH, content);
}

async function setupEnvFile(): Promise<Map<string, string>> {
  printSection('Environment Configuration');

  let env: Map<string, string>;

  if (fs.existsSync(ENV_PATH)) {
    printInfo('.env file already exists');
    const overwrite = await promptYesNo('Would you like to update it?', true);
    if (!overwrite) {
      return loadEnvFile();
    }
    env = loadEnvFile();
  } else {
    printInfo('Creating .env from .env.example');
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    env = new Map();
  }

  return env;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function generateWebhookSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Linear Setup
// ═══════════════════════════════════════════════════════════════════════════

async function setupLinearAuth(env: Map<string, string>, ngrokUrl: string | null): Promise<'oauth' | 'apikey'> {
  printSection('Linear Authentication');

  console.log(`TaskAgent can authenticate with Linear in two ways:

  ${colors.bold}1. OAuth Application${colors.reset} ${colors.green}(Recommended)${colors.reset}
     - Creates a dedicated bot user for TaskAgent
     - Bot appears as separate user in Linear
     - Better for team visibility

  ${colors.bold}2. Personal API Key${colors.reset}
     - Uses your personal Linear account
     - Faster setup, good for testing
     - Actions appear as coming from you
`);

  const useOAuth = await promptYesNo('Use OAuth application (recommended)?', true);

  if (useOAuth) {
    return await setupLinearOAuth(env, ngrokUrl);
  } else {
    return await setupLinearApiKey(env);
  }
}

async function setupLinearOAuth(env: Map<string, string>, ngrokUrl: string | null): Promise<'oauth'> {
  const redirectUrl = ngrokUrl ? `${ngrokUrl}/oauth/callback` : 'http://localhost:3456/oauth/callback';

  console.log(`
${colors.bold}Creating a Linear OAuth Application:${colors.reset}

  1. Go to: ${colors.cyan}https://linear.app/settings/api/applications${colors.reset}

  2. Click "${colors.bold}Create new application${colors.reset}"

  3. Fill in the application details:
     ${colors.bold}Name:${colors.reset} TaskAgent (or your preferred name)
     ${colors.bold}Description:${colors.reset} AI coding agent assistant
     ${colors.bold}Redirect URL:${colors.reset} ${colors.cyan}${redirectUrl}${colors.reset}

     ${colors.bold}IMPORTANT - Actor field:${colors.reset}
     ${colors.bold}Select "Application"${colors.reset} to create a dedicated bot user for TaskAgent.
     This makes TaskAgent appear as a separate user in Linear, not as you.

  4. ${colors.bold}Permissions:${colors.reset}
     The default permissions should be sufficient. TaskAgent needs:
     - Read access to issues and comments
     - Write access to create issues and comments
     - Ability to be assigned to issues

  5. Click "${colors.bold}Create${colors.reset}" and copy the Client ID and Client Secret

${ngrokUrl ? `
${colors.dim}Note: Using ngrok URL for redirect. If ngrok restarts, you'll need to update
the redirect URL in Linear's application settings.${colors.reset}
` : `
${colors.yellow}⚠ Warning:${colors.reset} ${colors.dim}Using localhost redirect URL. This won't work on remote/cloud machines.
Consider enabling webhooks for ngrok-based redirect URLs.${colors.reset}
`}
`);

  await waitForEnter('Press Enter after creating the application...');

  const clientId = await prompt(`${icons.arrow} Client ID: `);
  const clientSecret = await promptSecret(`${icons.arrow} Client Secret: `);

  if (!clientId || !clientSecret) {
    printError('Client ID and Secret are required for OAuth');
    process.exit(1);
  }

  env.set('LINEAR_CLIENT_ID', clientId);
  env.set('LINEAR_CLIENT_SECRET', clientSecret);
  // Clear API key if switching to OAuth
  env.delete('LINEAR_API_KEY');

  printSuccess('Linear OAuth credentials saved');
  return 'oauth';
}

async function setupLinearApiKey(env: Map<string, string>): Promise<'apikey'> {
  console.log(`
${colors.bold}Creating a Linear API Key:${colors.reset}

  1. Go to: ${colors.cyan}https://linear.app/settings/api${colors.reset}

  2. Under "Personal API keys", click "${colors.bold}Create key${colors.reset}"

  3. Give it a name like "TaskAgent"

  4. Copy the generated key (starts with lin_api_)
`);

  await waitForEnter('Press Enter after creating the API key...');

  const apiKey = await promptSecret(`${icons.arrow} API Key: `);

  if (!apiKey || !apiKey.startsWith('lin_api_')) {
    printError('Invalid API key format (should start with lin_api_)');
    process.exit(1);
  }

  env.set('LINEAR_API_KEY', apiKey);
  // Clear OAuth credentials if switching to API key
  env.delete('LINEAR_CLIENT_ID');
  env.delete('LINEAR_CLIENT_SECRET');

  printSuccess('Linear API key saved');
  return 'apikey';
}

async function fetchLinearTeams(env: Map<string, string>): Promise<void> {
  printSection('Linear Team Configuration');

  // Check if we have credentials to fetch teams
  const apiKey = env.get('LINEAR_API_KEY');
  const hasOAuth = env.get('LINEAR_CLIENT_ID') && env.get('LINEAR_CLIENT_SECRET');

  if (!apiKey && hasOAuth) {
    // For OAuth, we need to complete the auth flow first to get teams
    console.log(`
${colors.dim}Note: Team ID will be configured after OAuth authorization.
You'll be able to select your team in the next step.${colors.reset}
`);

    const teamId = await prompt(`${icons.arrow} If you know your team ID, enter it now (or press Enter to skip): `);
    if (teamId) {
      env.set('LINEAR_TEAM_ID', teamId);
    }
    return;
  }

  if (apiKey) {
    console.log('Fetching your Linear teams...\n');

    try {
      // Dynamic import to avoid issues if @linear/sdk isn't installed yet
      const { LinearClient } = await import('@linear/sdk');
      const client = new LinearClient({ apiKey });
      const teams = await client.teams();

      if (teams.nodes.length === 0) {
        printWarning('No teams found in your Linear workspace');
        const teamId = await prompt(`${icons.arrow} Enter your team ID manually: `);
        env.set('LINEAR_TEAM_ID', teamId);
        return;
      }

      console.log(`${colors.bold}Your Linear Teams:${colors.reset}\n`);
      console.log('  #  │ Key    │ Name');
      console.log('─────┼────────┼─────────────────────────────');

      teams.nodes.forEach((team, index) => {
        console.log(`  ${(index + 1).toString().padStart(2)} │ ${team.key.padEnd(6)} │ ${team.name}`);
      });

      console.log('');

      if (teams.nodes.length === 1) {
        const team = teams.nodes[0];
        const useThis = await promptYesNo(`Use "${team.name}" (${team.key})?`, true);
        if (useThis) {
          env.set('LINEAR_TEAM_ID', team.id);
          printSuccess(`Team ID set to ${team.id}`);
          return;
        }
      }

      const selection = await prompt(`${icons.arrow} Enter team number (1-${teams.nodes.length}): `);
      const index = parseInt(selection, 10) - 1;

      if (index >= 0 && index < teams.nodes.length) {
        const team = teams.nodes[index];
        env.set('LINEAR_TEAM_ID', team.id);
        printSuccess(`Team ID set to ${team.id} (${team.name})`);
      } else {
        printError('Invalid selection');
        const teamId = await prompt(`${icons.arrow} Enter team ID manually: `);
        env.set('LINEAR_TEAM_ID', teamId);
      }
    } catch (error) {
      printError(`Failed to fetch teams: ${error instanceof Error ? error.message : error}`);
      const teamId = await prompt(`${icons.arrow} Enter your team ID manually: `);
      env.set('LINEAR_TEAM_ID', teamId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Trigger Labels Setup
// ═══════════════════════════════════════════════════════════════════════════

// Label group configuration
const LABEL_GROUP = {
  name: 'task_agent',
  color: '#6366f1', // Indigo - the parent group color
  description: 'TaskAgent trigger labels',
};

const TRIGGER_LABELS = [
  { name: 'clarify', color: '#0ea5e9', description: 'Ask clarifying questions' },
  { name: 'refine', color: '#8b5cf6', description: 'Refine/rewrite the description' },
  { name: 'work', color: '#22c55e', description: 'Start working on this issue' },
  { name: 'plan', color: '#f59e0b', description: 'Enter planning mode' },
];

async function createTriggerLabels(env: Map<string, string>): Promise<void> {
  printSection('Creating Trigger Labels');

  const apiKey = env.get('LINEAR_API_KEY');
  const teamId = env.get('LINEAR_TEAM_ID');

  // For OAuth, we need to check if token exists
  const hasOAuth = env.get('LINEAR_CLIENT_ID') && env.get('LINEAR_CLIENT_SECRET');
  const tokenExists = fs.existsSync(TOKEN_PATH) || fs.existsSync(LEGACY_TOKEN_PATH);

  if (!teamId) {
    printWarning('No team ID configured, skipping label creation');
    return;
  }

  if (!apiKey && (!hasOAuth || !tokenExists)) {
    printInfo('Labels will be created after OAuth authorization');
    console.log(`
${colors.dim}You can also create these labels manually in Linear:
  Create a label group called "${LABEL_GROUP.name}" with sub-labels:
  - clarify: Ask clarifying questions
  - refine: Refine/rewrite the description
  - work: Start working on this issue
  - plan: Enter planning mode${colors.reset}
`);
    return;
  }

  console.log(`
TaskAgent uses a label group to trigger actions on issues.
Creating the "${colors.cyan}${LABEL_GROUP.name}${colors.reset}" label group with sub-labels:

  ${colors.cyan}${LABEL_GROUP.name}/clarify${colors.reset} - Ask clarifying questions
  ${colors.cyan}${LABEL_GROUP.name}/refine${colors.reset}  - Rewrite/improve the description
  ${colors.cyan}${LABEL_GROUP.name}/work${colors.reset}    - Start working on the issue
  ${colors.cyan}${LABEL_GROUP.name}/plan${colors.reset}    - Enter planning mode
`);

  const create = await promptYesNo('Create trigger labels now?', true);
  if (!create) {
    printInfo('Skipping label creation. You can create them manually in Linear.');
    return;
  }

  try {
    // Dynamic import to avoid issues if @linear/sdk isn't installed yet
    const { LinearClient } = await import('@linear/sdk');

    let client: InstanceType<typeof LinearClient>;

    if (apiKey) {
      client = new LinearClient({ apiKey });
    } else if (hasOAuth && tokenExists) {
      // Read OAuth token
      const tokenPath = fs.existsSync(TOKEN_PATH) ? TOKEN_PATH : LEGACY_TOKEN_PATH;
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      client = new LinearClient({ accessToken: tokenData.access_token });
    } else {
      printWarning('No valid credentials for label creation');
      return;
    }

    // Get existing labels for the team
    const team = await client.team(teamId);
    const existingLabels = await team.labels();
    const existingByName = new Map(existingLabels.nodes.map(l => [l.name.toLowerCase(), l]));

    let created = 0;
    let skipped = 0;

    // Step 1: Create or find the parent group label
    let parentLabelId: string;
    const existingParent = existingByName.get(LABEL_GROUP.name.toLowerCase());

    if (existingParent) {
      printInfo(`Label group "${LABEL_GROUP.name}" already exists`);
      parentLabelId = existingParent.id;
    } else {
      try {
        const parentResult = await client.createIssueLabel({
          name: LABEL_GROUP.name,
          color: LABEL_GROUP.color,
          description: LABEL_GROUP.description,
          teamId,
          isGroup: true, // Mark as a group label to allow children
        });
        const parentLabel = await parentResult.issueLabel;
        if (!parentLabel) {
          throw new Error('Failed to get created parent label');
        }
        parentLabelId = parentLabel.id;
        printSuccess(`Created label group "${LABEL_GROUP.name}"`);
        created++;
      } catch (error) {
        printWarning(`Failed to create label group "${LABEL_GROUP.name}": ${error instanceof Error ? error.message : error}`);
        return;
      }
    }

    // Step 2: Create child labels under the parent group
    for (const label of TRIGGER_LABELS) {
      // Check if child already exists (Linear stores as "parent/child" or just "child" with parentId)
      // We need to check both the full name and if a label with this name has this parent
      const existingChild = existingLabels.nodes.find(l => {
        const nameLower = l.name.toLowerCase();
        return nameLower === label.name.toLowerCase() ||
               nameLower === `${LABEL_GROUP.name.toLowerCase()}/${label.name.toLowerCase()}`;
      });

      if (existingChild) {
        printInfo(`Label "${label.name}" already exists`);
        skipped++;
      } else {
        try {
          await client.createIssueLabel({
            name: label.name,
            color: label.color,
            description: label.description,
            teamId,
            parentId: parentLabelId,
          });
          printSuccess(`Created label "${LABEL_GROUP.name}/${label.name}"`);
          created++;
        } catch (error) {
          printWarning(`Failed to create label "${label.name}": ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    if (created > 0) {
      console.log(`\n${icons.check} Created ${created} trigger label(s)`);
    }
    if (skipped > 0) {
      console.log(`${icons.info} ${skipped} label(s) already existed`);
    }

  } catch (error) {
    printWarning(`Failed to create labels: ${error instanceof Error ? error.message : error}`);
    console.log(`
${colors.dim}You can create these labels manually in Linear:
  Settings > Team Settings > Labels > New Label

  Create a label group called "${LABEL_GROUP.name}" with sub-labels:
  - clarify: Ask clarifying questions
  - refine: Rewrite/improve the description
  - work: Start working on the issue
  - plan: Enter planning mode${colors.reset}
`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Anthropic Setup
// ═══════════════════════════════════════════════════════════════════════════

async function setupAnthropic(env: Map<string, string>): Promise<void> {
  printSection('Anthropic API Configuration');

  const existingKey = env.get('ANTHROPIC_API_KEY');
  if (existingKey && existingKey !== 'sk-ant-xxxx' && existingKey.startsWith('sk-ant-')) {
    printInfo('Anthropic API key already configured');
    const update = await promptYesNo('Would you like to update it?', false);
    if (!update) return;
  }

  console.log(`
${colors.bold}Getting an Anthropic API Key:${colors.reset}

  1. Go to: ${colors.cyan}https://console.anthropic.com/settings/keys${colors.reset}

  2. Click "${colors.bold}Create Key${colors.reset}"

  3. Copy the generated key (starts with sk-ant-)
`);

  await waitForEnter('Press Enter after creating the API key...');

  const apiKey = await promptSecret(`${icons.arrow} Anthropic API Key: `);

  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    printWarning('API key format looks unusual (expected sk-ant-...)');
    const proceed = await promptYesNo('Continue anyway?', false);
    if (!proceed) {
      process.exit(1);
    }
  }

  env.set('ANTHROPIC_API_KEY', apiKey);

  // Model selection
  console.log(`
${colors.bold}Select default model:${colors.reset}

  1. claude-sonnet-4-5 ${colors.green}(Recommended)${colors.reset} - Best balance of speed and quality
  2. claude-opus-4-5 - Highest quality, slower
  3. claude-haiku-4-5 - Fastest, lower quality
`);

  const modelChoice = await promptWithDefault('Model', '1');
  const models: Record<string, string> = {
    '1': 'claude-sonnet-4-5',
    '2': 'claude-opus-4-5',
    '3': 'claude-haiku-4-5',
  };

  env.set('ANTHROPIC_MODEL', models[modelChoice] || 'claude-sonnet-4-5');
  printSuccess(`Model set to ${env.get('ANTHROPIC_MODEL')}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// GitHub Setup
// ═══════════════════════════════════════════════════════════════════════════

async function setupGitHub(env: Map<string, string>): Promise<void> {
  printSection('GitHub Repository Configuration');

  console.log(`
TaskAgent needs to know which repository to work with.
This is where agents will create branches and pull requests.
`);

  const existingRepo = env.get('GITHUB_REPO');
  const defaultRepo = existingRepo && existingRepo !== 'owner/repo-name' ? existingRepo : '';

  let repo: string;
  if (defaultRepo) {
    repo = await promptWithDefault('GitHub repository (owner/repo)', defaultRepo);
  } else {
    repo = await prompt(`${icons.arrow} GitHub repository (e.g., myorg/myrepo): `);
  }

  if (!repo.includes('/')) {
    printError('Repository should be in format: owner/repo');
    process.exit(1);
  }

  env.set('GITHUB_REPO', repo);
  printSuccess(`GitHub repository set to ${repo}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent Configuration
// ═══════════════════════════════════════════════════════════════════════════

async function setupAgentConcurrency(env: Map<string, string>): Promise<void> {
  printSection('Agent Concurrency Settings');

  console.log(`
${colors.bold}How many agents should run in parallel?${colors.reset}

  ${colors.bold}Analysis tasks${colors.reset}: Ticket evaluation, refinement, etc.
  ${colors.bold}Code executors${colors.reset}: Claude Code instances that write code

${colors.dim}Start with lower values and increase as needed.${colors.reset}
`);

  const maxConcurrent = await promptWithDefault('Max concurrent analysis tasks', env.get('AGENTS_MAX_CONCURRENT') || '5');
  env.set('AGENTS_MAX_CONCURRENT', maxConcurrent);

  const maxCodeExecutors = await promptWithDefault('Max concurrent code executors', env.get('AGENTS_MAX_CODE_EXECUTORS') || '1');
  env.set('AGENTS_MAX_CODE_EXECUTORS', maxCodeExecutors);

  printSuccess('Concurrency settings saved');
}

// ═══════════════════════════════════════════════════════════════════════════
// Repository Analysis
// ═══════════════════════════════════════════════════════════════════════════

// Auto-generated section - populated by scanning the filesystem
interface AutoGeneratedSection {
  path: string;
  name: string;
  description?: string;
  languages: string[];
  frameworks: string[];
  databases: string[];
  testing: string[];
  tooling: string[];
  structure: {
    sourceDir?: string;
    testDir?: string;
    hasDocker: boolean;
    hasCICD: boolean;
  };
  scripts: Record<string, string>;
  dependencies: {
    production: string[];
    development: string[];
  };
  readme?: string;
}

// Manual section - edited by developers to add domain knowledge
interface ManualSection {
  domainConcepts?: string;
  architectureNotes?: string;
  apiEndpoints?: string;
  dataModels?: string;
  conventions?: string;
  additionalContext?: string;
}

// Full repo summary schema
interface EnhancedRepoSummary {
  version: number;
  generatedAt: string;
  lastManualEdit?: string;
  auto: AutoGeneratedSection;
  manual: ManualSection;
  _documentation: string;
}

const REPO_SUMMARY_DOCUMENTATION = `
This file contains context about your repository for TaskAgent.

SECTIONS:
- auto: Auto-generated by running 'npm run setup' or 'npx tsx scripts/generate-repo-summary.ts'
- manual: Edit these fields to provide domain knowledge

MANUAL SECTION FIELDS:
- domainConcepts: Key business concepts and domain terminology
- architectureNotes: Architectural decisions and patterns
- apiEndpoints: Key API routes and their purposes
- dataModels: Important data models and relationships
- conventions: Code conventions not captured by linters

Edit the manual section to help TaskAgent ask better questions.
`.trim();

// Directories to exclude when scanning
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.task-agent', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.cache', '.turbo',
  'vendor', 'target', 'bin', 'obj', '.idea', '.vscode',
]);

async function analyzeRepository(workDir: string): Promise<EnhancedRepoSummary | null> {
  printSection('Analyzing Target Repository');

  if (!fs.existsSync(workDir)) {
    printError(`Directory does not exist: ${workDir}`);
    return null;
  }

  console.log(`Scanning ${colors.cyan}${workDir}${colors.reset}...\n`);

  // Check for existing file to preserve manual sections
  let existingManual: ManualSection = {};
  let existingLastManualEdit: string | undefined;

  if (fs.existsSync(REPO_SUMMARY_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(REPO_SUMMARY_PATH, 'utf-8'));
      if (existing.manual) {
        existingManual = existing.manual;
        existingLastManualEdit = existing.lastManualEdit;
        console.log(`  ${colors.dim}Preserving existing manual sections...${colors.reset}`);
      }
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const auto: AutoGeneratedSection = {
    path: workDir,
    name: path.basename(workDir),
    languages: [],
    frameworks: [],
    databases: [],
    testing: [],
    tooling: [],
    structure: {
      hasDocker: false,
      hasCICD: false,
    },
    scripts: {},
    dependencies: {
      production: [],
      development: [],
    },
  };

  // Detect project type and package manager
  const packageJsonPath = path.join(workDir, 'package.json');
  const cargoTomlPath = path.join(workDir, 'Cargo.toml');
  const goModPath = path.join(workDir, 'go.mod');
  const pyprojectPath = path.join(workDir, 'pyproject.toml');
  const requirementsPath = path.join(workDir, 'requirements.txt');
  const gemfilePath = path.join(workDir, 'Gemfile');

  // Node.js / JavaScript / TypeScript
  if (fs.existsSync(packageJsonPath)) {
    await analyzeNodeProject(workDir, packageJsonPath, auto);
  }

  // Rust
  if (fs.existsSync(cargoTomlPath)) {
    auto.languages.push('Rust');
    await analyzeCargoProject(cargoTomlPath, auto);
  }

  // Go
  if (fs.existsSync(goModPath)) {
    auto.languages.push('Go');
    await analyzeGoProject(workDir, goModPath, auto);
  }

  // Python
  if (fs.existsSync(pyprojectPath) || fs.existsSync(requirementsPath)) {
    auto.languages.push('Python');
    await analyzePythonProject(workDir, auto);
  }

  // Ruby
  if (fs.existsSync(gemfilePath)) {
    auto.languages.push('Ruby');
    await analyzeRubyProject(workDir, auto);
  }

  // Scan directory structure
  await scanDirectoryStructure(workDir, auto);

  // Get README summary
  auto.readme = getReadmeSummary(workDir);

  const summary: EnhancedRepoSummary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lastManualEdit: existingLastManualEdit,
    auto,
    manual: existingManual,
    _documentation: REPO_SUMMARY_DOCUMENTATION,
  };

  // Display summary
  displayRepoSummary(summary);

  return summary;
}

async function analyzeNodeProject(workDir: string, packageJsonPath: string, summary: AutoGeneratedSection): Promise<void> {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);

    summary.name = pkg.name || summary.name;
    summary.description = pkg.description;

    const deps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    const allDeps = [...deps, ...devDeps];

    summary.dependencies.production = deps.slice(0, 20); // Limit for display
    summary.dependencies.development = devDeps.slice(0, 20);

    // Language detection
    if (allDeps.includes('typescript') || fs.existsSync(path.join(workDir, 'tsconfig.json'))) {
      summary.languages.push('TypeScript');
    } else {
      summary.languages.push('JavaScript');
    }

    // Framework detection
    if (allDeps.includes('next')) summary.frameworks.push('Next.js');
    else if (allDeps.includes('react')) summary.frameworks.push('React');
    if (allDeps.includes('vue')) summary.frameworks.push('Vue.js');
    if (allDeps.includes('angular') || allDeps.includes('@angular/core')) summary.frameworks.push('Angular');
    if (allDeps.includes('svelte')) summary.frameworks.push('Svelte');
    if (allDeps.includes('express')) summary.frameworks.push('Express.js');
    if (allDeps.includes('fastify')) summary.frameworks.push('Fastify');
    if (allDeps.includes('@nestjs/core')) summary.frameworks.push('NestJS');
    if (allDeps.includes('hono')) summary.frameworks.push('Hono');
    if (allDeps.includes('koa')) summary.frameworks.push('Koa');

    // Database detection
    if (allDeps.includes('prisma') || allDeps.includes('@prisma/client')) summary.databases.push('Prisma');
    if (allDeps.includes('mongoose')) summary.databases.push('MongoDB (Mongoose)');
    if (allDeps.includes('pg') || allDeps.includes('postgres')) summary.databases.push('PostgreSQL');
    if (allDeps.includes('mysql') || allDeps.includes('mysql2')) summary.databases.push('MySQL');
    if (allDeps.includes('better-sqlite3') || allDeps.includes('sqlite3')) summary.databases.push('SQLite');
    if (allDeps.includes('redis') || allDeps.includes('ioredis')) summary.databases.push('Redis');
    if (allDeps.includes('drizzle-orm')) summary.databases.push('Drizzle ORM');
    if (allDeps.includes('typeorm')) summary.databases.push('TypeORM');
    if (allDeps.includes('sequelize')) summary.databases.push('Sequelize');

    // Testing detection
    if (allDeps.includes('jest')) summary.testing.push('Jest');
    if (allDeps.includes('vitest')) summary.testing.push('Vitest');
    if (allDeps.includes('mocha')) summary.testing.push('Mocha');
    if (allDeps.includes('@playwright/test')) summary.testing.push('Playwright');
    if (allDeps.includes('cypress')) summary.testing.push('Cypress');
    if (allDeps.includes('@testing-library/react')) summary.testing.push('React Testing Library');

    // Tooling detection
    if (allDeps.includes('eslint')) summary.tooling.push('ESLint');
    if (allDeps.includes('prettier')) summary.tooling.push('Prettier');
    if (allDeps.includes('husky')) summary.tooling.push('Husky');
    if (allDeps.includes('lint-staged')) summary.tooling.push('lint-staged');
    if (allDeps.includes('turbo')) summary.tooling.push('Turborepo');
    if (allDeps.includes('nx')) summary.tooling.push('Nx');
    if (allDeps.includes('lerna')) summary.tooling.push('Lerna');

    // Scripts
    if (pkg.scripts) {
      const importantScripts = ['build', 'dev', 'start', 'test', 'lint', 'typecheck', 'format'];
      for (const script of importantScripts) {
        if (pkg.scripts[script]) {
          summary.scripts[script] = pkg.scripts[script];
        }
      }
    }
  } catch (error) {
    printWarning(`Failed to parse package.json: ${error instanceof Error ? error.message : error}`);
  }
}

async function analyzeCargoProject(cargoPath: string, summary: AutoGeneratedSection): Promise<void> {
  try {
    const content = fs.readFileSync(cargoPath, 'utf-8');

    // Simple TOML parsing for name
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      summary.name = nameMatch[1];
    }

    const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
    if (descMatch) {
      summary.description = descMatch[1];
    }

    // Framework detection
    if (content.includes('actix')) summary.frameworks.push('Actix');
    if (content.includes('axum')) summary.frameworks.push('Axum');
    if (content.includes('rocket')) summary.frameworks.push('Rocket');
    if (content.includes('tokio')) summary.tooling.push('Tokio');

    // Database detection
    if (content.includes('diesel')) summary.databases.push('Diesel');
    if (content.includes('sqlx')) summary.databases.push('SQLx');
    if (content.includes('sea-orm')) summary.databases.push('SeaORM');
  } catch {
    // Ignore parse errors
  }
}

async function analyzeGoProject(workDir: string, goModPath: string, summary: AutoGeneratedSection): Promise<void> {
  try {
    const content = fs.readFileSync(goModPath, 'utf-8');

    // Module name
    const modMatch = content.match(/^module\s+(\S+)/m);
    if (modMatch) {
      summary.name = modMatch[1].split('/').pop() || summary.name;
    }

    // Framework detection
    if (content.includes('gin-gonic')) summary.frameworks.push('Gin');
    if (content.includes('labstack/echo')) summary.frameworks.push('Echo');
    if (content.includes('gofiber/fiber')) summary.frameworks.push('Fiber');
    if (content.includes('gorilla/mux')) summary.frameworks.push('Gorilla Mux');
    if (content.includes('go-chi/chi')) summary.frameworks.push('Chi');

    // Database detection
    if (content.includes('gorm.io')) summary.databases.push('GORM');
    if (content.includes('sqlx')) summary.databases.push('sqlx');
    if (content.includes('go-redis')) summary.databases.push('Redis');
  } catch {
    // Ignore parse errors
  }
}

async function analyzePythonProject(workDir: string, summary: AutoGeneratedSection): Promise<void> {
  const requirementsPath = path.join(workDir, 'requirements.txt');
  const pyprojectPath = path.join(workDir, 'pyproject.toml');

  let requirements = '';

  try {
    if (fs.existsSync(requirementsPath)) {
      requirements = fs.readFileSync(requirementsPath, 'utf-8');
    }
    if (fs.existsSync(pyprojectPath)) {
      const pyproject = fs.readFileSync(pyprojectPath, 'utf-8');
      requirements += '\n' + pyproject;

      // Extract name from pyproject.toml
      const nameMatch = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) {
        summary.name = nameMatch[1];
      }
    }

    // Framework detection
    if (requirements.includes('django')) summary.frameworks.push('Django');
    if (requirements.includes('flask')) summary.frameworks.push('Flask');
    if (requirements.includes('fastapi')) summary.frameworks.push('FastAPI');
    if (requirements.includes('starlette')) summary.frameworks.push('Starlette');

    // Database detection
    if (requirements.includes('sqlalchemy')) summary.databases.push('SQLAlchemy');
    if (requirements.includes('django')) summary.databases.push('Django ORM');
    if (requirements.includes('pymongo')) summary.databases.push('MongoDB');
    if (requirements.includes('psycopg')) summary.databases.push('PostgreSQL');
    if (requirements.includes('redis')) summary.databases.push('Redis');

    // Testing detection
    if (requirements.includes('pytest')) summary.testing.push('pytest');
    if (requirements.includes('unittest')) summary.testing.push('unittest');
  } catch {
    // Ignore parse errors
  }
}

async function analyzeRubyProject(workDir: string, summary: AutoGeneratedSection): Promise<void> {
  const gemfilePath = path.join(workDir, 'Gemfile');

  try {
    const content = fs.readFileSync(gemfilePath, 'utf-8');

    // Framework detection
    if (content.includes("'rails'") || content.includes('"rails"')) summary.frameworks.push('Ruby on Rails');
    if (content.includes("'sinatra'") || content.includes('"sinatra"')) summary.frameworks.push('Sinatra');
    if (content.includes("'hanami'") || content.includes('"hanami"')) summary.frameworks.push('Hanami');

    // Database detection
    if (content.includes('activerecord')) summary.databases.push('ActiveRecord');
    if (content.includes('sequel')) summary.databases.push('Sequel');
    if (content.includes("'pg'") || content.includes('"pg"')) summary.databases.push('PostgreSQL');
    if (content.includes('redis')) summary.databases.push('Redis');

    // Testing detection
    if (content.includes('rspec')) summary.testing.push('RSpec');
    if (content.includes('minitest')) summary.testing.push('Minitest');
    if (content.includes('capybara')) summary.testing.push('Capybara');
  } catch {
    // Ignore parse errors
  }
}

async function scanDirectoryStructure(workDir: string, summary: AutoGeneratedSection): Promise<void> {
  try {
    const entries = fs.readdirSync(workDir, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;

        // Source directories
        if (['src', 'lib', 'app', 'source', 'pkg', 'internal', 'cmd'].includes(name)) {
          summary.structure.sourceDir = name;
        }

        // Test directories
        if (['test', 'tests', '__tests__', 'spec', 'specs', 'test_', '_test'].includes(name)) {
          summary.structure.testDir = name;
        }

        // CI/CD directories
        if (['.github', '.gitlab', '.circleci', '.buildkite'].includes(name)) {
          summary.structure.hasCICD = true;
        }
      } else if (entry.isFile()) {
        // Docker
        if (name === 'Dockerfile' || name === 'docker-compose.yml' || name === 'docker-compose.yaml') {
          summary.structure.hasDocker = true;
          summary.tooling.push('Docker');
        }

        // CI/CD files
        if (name === '.travis.yml' || name === 'Jenkinsfile' || name === 'azure-pipelines.yml') {
          summary.structure.hasCICD = true;
        }

        // Config files
        if (name === 'tsconfig.json' && !summary.tooling.includes('TypeScript')) {
          summary.tooling.push('TypeScript');
        }
        if ((name.includes('eslint') || name === '.eslintrc.json' || name === '.eslintrc.js') && !summary.tooling.includes('ESLint')) {
          summary.tooling.push('ESLint');
        }
        if ((name.includes('prettier') || name === '.prettierrc') && !summary.tooling.includes('Prettier')) {
          summary.tooling.push('Prettier');
        }
      }
    }
  } catch (error) {
    printWarning(`Failed to scan directory: ${error instanceof Error ? error.message : error}`);
  }
}

function getReadmeSummary(workDir: string): string | undefined {
  const readmeNames = ['README.md', 'readme.md', 'README', 'README.txt', 'README.rst'];

  for (const name of readmeNames) {
    const readmePath = path.join(workDir, name);
    try {
      if (fs.existsSync(readmePath)) {
        const content = fs.readFileSync(readmePath, 'utf-8');
        // Extract first meaningful paragraph (skip title and badges)
        const lines = content.split('\n');
        const paragraphs: string[] = [];
        let foundContent = false;

        for (const line of lines) {
          const trimmed = line.trim();
          // Skip headers and badges
          if (trimmed.startsWith('#') || trimmed.startsWith('![') || trimmed.startsWith('[![')) {
            continue;
          }
          if (trimmed.length > 0) {
            paragraphs.push(trimmed);
            foundContent = true;
            if (paragraphs.join(' ').length > 500) break;
          } else if (foundContent && paragraphs.length > 0) {
            break; // End of first paragraph
          }
        }

        const summary = paragraphs.join(' ').slice(0, 500);
        return summary.length > 0 ? summary : undefined;
      }
    } catch {
      // Continue to next README variant
    }
  }

  return undefined;
}

function displayRepoSummary(summary: EnhancedRepoSummary): void {
  const { auto, manual } = summary;

  console.log(`${colors.bold}Repository Summary${colors.reset}\n`);

  console.log(`  ${colors.bold}Name:${colors.reset} ${auto.name}`);
  if (auto.description) {
    console.log(`  ${colors.bold}Description:${colors.reset} ${auto.description}`);
  }
  console.log(`  ${colors.bold}Path:${colors.reset} ${auto.path}`);

  if (auto.languages.length > 0) {
    console.log(`\n  ${colors.bold}Languages:${colors.reset} ${auto.languages.join(', ')}`);
  }

  if (auto.frameworks.length > 0) {
    console.log(`  ${colors.bold}Frameworks:${colors.reset} ${auto.frameworks.join(', ')}`);
  }

  if (auto.databases.length > 0) {
    console.log(`  ${colors.bold}Databases:${colors.reset} ${auto.databases.join(', ')}`);
  }

  if (auto.testing.length > 0) {
    console.log(`  ${colors.bold}Testing:${colors.reset} ${auto.testing.join(', ')}`);
  }

  if (auto.tooling.length > 0) {
    console.log(`  ${colors.bold}Tooling:${colors.reset} ${auto.tooling.join(', ')}`);
  }

  const structureParts: string[] = [];
  if (auto.structure.sourceDir) structureParts.push(`source: ${auto.structure.sourceDir}/`);
  if (auto.structure.testDir) structureParts.push(`tests: ${auto.structure.testDir}/`);
  if (auto.structure.hasDocker) structureParts.push('Docker');
  if (auto.structure.hasCICD) structureParts.push('CI/CD');

  if (structureParts.length > 0) {
    console.log(`  ${colors.bold}Structure:${colors.reset} ${structureParts.join(', ')}`);
  }

  if (Object.keys(auto.scripts).length > 0) {
    console.log(`\n  ${colors.bold}Available Scripts:${colors.reset}`);
    for (const [name, cmd] of Object.entries(auto.scripts)) {
      const displayCmd = cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
      console.log(`    ${colors.cyan}${name}${colors.reset}: ${displayCmd}`);
    }
  }

  if (auto.readme) {
    console.log(`\n  ${colors.bold}About:${colors.reset}`);
    console.log(`    ${colors.dim}${auto.readme.slice(0, 200)}${auto.readme.length > 200 ? '...' : ''}${colors.reset}`);
  }

  // Show manual sections status
  const manualFields = Object.entries(manual).filter(([_, v]) => v);
  if (manualFields.length > 0) {
    console.log(`\n  ${colors.bold}Manual Sections:${colors.reset}`);
    for (const [key, _] of manualFields) {
      console.log(`    ${colors.green}+${colors.reset} ${key}`);
    }
  } else {
    console.log(`\n  ${colors.dim}Manual Sections: (none - edit the JSON file to add domain context)${colors.reset}`);
  }

  console.log('');
}

function saveRepoSummary(summary: EnhancedRepoSummary): void {
  try {
    fs.writeFileSync(REPO_SUMMARY_PATH, JSON.stringify(summary, null, 2));
    printSuccess(`Repository summary saved to ${path.basename(REPO_SUMMARY_PATH)}`);
  } catch (error) {
    printWarning(`Failed to save repository summary: ${error instanceof Error ? error.message : error}`);
  }
}

async function setupTargetRepository(env: Map<string, string>): Promise<string | null> {
  printSection('Target Repository');

  console.log(`
${colors.bold}Which repository will TaskAgent work on?${colors.reset}

TaskAgent needs a local clone of your target repository where agents will
create branches, write code, and submit pull requests.

This should be an ${colors.bold}absolute path${colors.reset} to a git repository on your machine.
`);

  const existingWorkDir = env.get('AGENTS_WORK_DIR');
  const defaultWorkDir = existingWorkDir && existingWorkDir !== '/path/to/target/repo' ? existingWorkDir : '';

  let workDir: string;
  if (defaultWorkDir) {
    workDir = await promptWithDefault('Repository path', defaultWorkDir);
  } else {
    workDir = await prompt(`${icons.arrow} Repository path: `);
  }

  if (!workDir) {
    printError('Repository path is required');
    return null;
  }

  // Expand ~ to home directory
  if (workDir.startsWith('~')) {
    workDir = workDir.replace('~', process.env.HOME || '');
  }

  // Make absolute
  if (!path.isAbsolute(workDir)) {
    workDir = path.resolve(process.cwd(), workDir);
  }

  // Validate directory exists
  if (!fs.existsSync(workDir)) {
    printError(`Directory does not exist: ${workDir}`);
    const create = await promptYesNo('Would you like to clone a repository there instead?', false);
    if (create) {
      console.log(`
${colors.dim}To clone a repository, run:${colors.reset}
  git clone <repo-url> ${workDir}

${colors.dim}Then re-run this setup script.${colors.reset}
`);
      return null;
    }
    return null;
  }

  // Check if it's a git repository
  const gitDir = path.join(workDir, '.git');
  if (!fs.existsSync(gitDir)) {
    printWarning('Directory is not a git repository');
    const proceed = await promptYesNo('Continue anyway?', false);
    if (!proceed) {
      return null;
    }
  }

  env.set('AGENTS_WORK_DIR', workDir);

  // Analyze the repository
  const summary = await analyzeRepository(workDir);

  if (summary) {
    saveRepoSummary(summary);

    // Try to auto-detect GitHub repo from git remote
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Parse GitHub URL (SSH or HTTPS)
      let repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
      if (repoMatch) {
        const repo = repoMatch[1].replace(/\.git$/, '');
        const useDetected = await promptYesNo(`Detected GitHub repo: ${repo}. Use this?`, true);
        if (useDetected) {
          env.set('GITHUB_REPO', repo);
          printSuccess(`GitHub repository set to ${repo}`);
        }
      }
    } catch {
      // No remote or not a git repo, will ask later
    }
  }

  return workDir;
}

// ═══════════════════════════════════════════════════════════════════════════
// Webhook Setup
// ═══════════════════════════════════════════════════════════════════════════

async function setupWebhooks(env: Map<string, string>): Promise<{ enabled: boolean; ngrokUrl: string | null }> {
  printSection('Webhook Configuration (Optional)');

  console.log(`
${colors.bold}Webhooks${colors.reset} enable real-time updates from Linear.

Without webhooks: TaskAgent polls Linear every 30 seconds
With webhooks: TaskAgent gets instant notifications

${colors.bold}Benefits:${colors.reset}
- Immediate response to Linear changes
- Works on remote/cloud development machines
- OAuth redirect URLs work from anywhere

${colors.dim}Webhooks require ngrok (or similar tunnel) to expose your local server.${colors.reset}
`);

  const enableWebhooks = await promptYesNo('Enable webhooks?', false);

  if (!enableWebhooks) {
    env.set('WEBHOOK_ENABLED', 'false');
    printInfo('Webhooks disabled. TaskAgent will use polling.');
    return { enabled: false, ngrokUrl: null };
  }

  env.set('WEBHOOK_ENABLED', 'true');

  // Check ngrok
  let ngrokInstalled = false;
  try {
    execSync('which ngrok', { encoding: 'utf-8' });
    ngrokInstalled = true;
  } catch {
    ngrokInstalled = false;
  }

  if (!ngrokInstalled) {
    console.log(`
${colors.bold}Installing ngrok:${colors.reset}

ngrok is required for webhooks. Install it with:

  ${colors.cyan}brew install ngrok${colors.reset}

Then authenticate with your ngrok account:

  ${colors.cyan}ngrok config add-authtoken <your-token>${colors.reset}

Get your token at: ${colors.cyan}https://dashboard.ngrok.com/get-started/your-authtoken${colors.reset}
`);

    const installNow = await promptYesNo('Would you like to install ngrok now?', true);

    if (installNow) {
      console.log('\nInstalling ngrok via Homebrew...\n');
      try {
        execSync('brew install ngrok', { stdio: 'inherit' });
        printSuccess('ngrok installed');

        console.log(`
${colors.bold}Next:${colors.reset} Authenticate ngrok with your account token.
Get your token at: ${colors.cyan}https://dashboard.ngrok.com/get-started/your-authtoken${colors.reset}
`);

        const authToken = await promptSecret(`${icons.arrow} ngrok auth token (or Enter to skip): `);
        if (authToken) {
          execSync(`ngrok config add-authtoken ${authToken}`, { stdio: 'inherit' });
          printSuccess('ngrok authenticated');
        }
      } catch (error) {
        printError('Failed to install ngrok. Please install manually.');
        env.set('WEBHOOK_ENABLED', 'false');
        return { enabled: false, ngrokUrl: null };
      }
    } else {
      printWarning('ngrok not installed. Disabling webhooks.');
      env.set('WEBHOOK_ENABLED', 'false');
      return { enabled: false, ngrokUrl: null };
    }
  }

  const port = await promptWithDefault('Webhook port', env.get('WEBHOOK_PORT') || '3000');
  env.set('WEBHOOK_PORT', port);

  // Generate webhook signing secret
  const webhookSecret = generateWebhookSecret();
  env.set('LINEAR_WEBHOOK_SECRET', webhookSecret);

  // Start ngrok to get the URL
  console.log(`\n${colors.bold}Starting ngrok tunnel...${colors.reset}`);
  console.log(`${colors.dim}This may take a few seconds...${colors.reset}\n`);

  let ngrokUrl: string | null = null;
  try {
    const ngrokProc = spawn('ngrok', ['http', port, '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for ngrok URL
    ngrokUrl = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        ngrokProc.kill();
        resolve(null);
      }, 10000); // 10 second timeout

      ngrokProc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        const urlMatch = text.match(/url=(https:\/\/[^\s]+\.ngrok[^\s]*)/);
        if (urlMatch && urlMatch[1]) {
          clearTimeout(timeout);
          resolve(urlMatch[1]);
          return;
        }

        const jsonUrlMatch = text.match(/"URL":"(https:\/\/[^"]+)"/);
        if (jsonUrlMatch && jsonUrlMatch[1]) {
          clearTimeout(timeout);
          resolve(jsonUrlMatch[1]);
          return;
        }
      });

      ngrokProc.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });

    // Kill the temporary ngrok process
    ngrokProc.kill();
  } catch (error) {
    printWarning('Failed to start ngrok automatically');
  }

  if (ngrokUrl) {
    printSuccess(`Ngrok URL obtained: ${ngrokUrl}`);
  } else {
    printWarning('Could not automatically detect ngrok URL');
    console.log(`${colors.dim}You'll need to start ngrok manually and copy the URL${colors.reset}\n`);
  }

  console.log(`
${colors.bold}Linear Webhook Configuration:${colors.reset}

After completing this setup, configure the webhook in Linear:

  1. Go to: ${colors.cyan}https://linear.app/settings/api/webhooks${colors.reset}

  2. Click "${colors.bold}Create webhook${colors.reset}"

  3. Fill in the webhook details:
     ${colors.bold}Label:${colors.reset} TaskAgent
     ${colors.bold}Webhook URL:${colors.reset} ${colors.cyan}${ngrokUrl ? `${ngrokUrl}/webhook` : '<ngrok-url>/webhook'}${colors.reset}
     ${colors.bold}Enable webhook:${colors.reset} ✓ Check this box

  4. ${colors.bold}Webhook signing secret:${colors.reset}
     Paste this secret (already saved to .env):
     ${colors.cyan}${webhookSecret}${colors.reset}

  5. ${colors.bold}Data change events${colors.reset} - Select these events:
     ${colors.bold}Issue:${colors.reset}
       ☑ Issue created
       ☑ Issue updated
       ☑ Issue removed
     ${colors.bold}Comment:${colors.reset}
       ☑ Comment created
       ☑ Comment updated

  6. Click "${colors.bold}Create webhook${colors.reset}"

${colors.yellow}IMPORTANT:${colors.reset} ${colors.dim}Keep ngrok running while TaskAgent is active.
If you restart ngrok and get a new URL, update the webhook URL in Linear.${colors.reset}
`);

  await waitForEnter();

  return { enabled: true, ngrokUrl };
}

// ═══════════════════════════════════════════════════════════════════════════
// OAuth Flow
// ═══════════════════════════════════════════════════════════════════════════

async function runOAuthFlow(env: Map<string, string>): Promise<void> {
  printSection('Linear OAuth Authorization');

  const clientId = env.get('LINEAR_CLIENT_ID');
  const clientSecret = env.get('LINEAR_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    printInfo('OAuth not configured, skipping authorization');
    return;
  }

  console.log(`
This will open your browser to authorize TaskAgent with Linear.
You'll be redirected back automatically after granting permission.
`);

  const proceed = await promptYesNo('Run OAuth authorization now?', true);

  if (!proceed) {
    printInfo('You can run OAuth later with: npm run auth');
    return;
  }

  // Save env file first so auth script can read it
  saveEnvFile(env);

  console.log('\nStarting OAuth flow...\n');

  return new Promise((resolve, reject) => {
    const authProcess = spawn('npx', ['tsx', 'scripts/auth.ts'], {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        LINEAR_CLIENT_ID: clientId,
        LINEAR_CLIENT_SECRET: clientSecret,
      },
    });

    authProcess.on('close', (code) => {
      if (code === 0) {
        printSuccess('OAuth authorization complete!');
        resolve();
      } else {
        printWarning('OAuth authorization may have failed. You can retry with: npm run auth');
        resolve(); // Don't fail the whole setup
      }
    });

    authProcess.on('error', (error) => {
      printError(`OAuth error: ${error.message}`);
      resolve(); // Don't fail the whole setup
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Final Verification
// ═══════════════════════════════════════════════════════════════════════════

async function installDependencies(): Promise<void> {
  printSection('Installing Dependencies');

  console.log('Running npm install...\n');

  try {
    execSync('npm install', { stdio: 'inherit', cwd: PROJECT_ROOT });
    printSuccess('Dependencies installed');
  } catch (error) {
    printError('Failed to install dependencies');
    throw error;
  }
}

function verifySetup(env: Map<string, string>): boolean {
  printSection('Verifying Setup');

  let allGood = true;

  // Check required env vars
  const required = [
    ['LINEAR_TEAM_ID', 'Linear team ID'],
    ['ANTHROPIC_API_KEY', 'Anthropic API key'],
    ['GITHUB_REPO', 'GitHub repository'],
    ['AGENTS_WORK_DIR', 'Agent work directory'],
  ];

  // Check auth
  const hasOAuth = env.get('LINEAR_CLIENT_ID') && env.get('LINEAR_CLIENT_SECRET');
  const hasApiKey = env.get('LINEAR_API_KEY');

  if (!hasOAuth && !hasApiKey) {
    printError('Missing Linear authentication');
    allGood = false;
  } else {
    printSuccess(`Linear auth: ${hasOAuth ? 'OAuth' : 'API Key'}`);
  }

  for (const [key, name] of required) {
    const value = env.get(key);
    const isPlaceholder = !value ||
      value === 'your-team-id' ||
      value === 'sk-ant-xxxx' ||
      value === 'owner/repo-name' ||
      value === '/path/to/target/repo';

    if (isPlaceholder) {
      printError(`Missing ${name} (${key})`);
      allGood = false;
    } else {
      printSuccess(`${name}: ${key === 'ANTHROPIC_API_KEY' ? '****' : value}`);
    }
  }

  // Check token file if OAuth (check both new and legacy paths)
  if (hasOAuth) {
    if (fs.existsSync(TOKEN_PATH) || fs.existsSync(LEGACY_TOKEN_PATH)) {
      printSuccess('OAuth token file exists');
    } else {
      printWarning('OAuth token not found (run: npm run auth)');
    }
  }

  return allGood;
}

function printNextSteps(env: Map<string, string>): void {
  printSection('Setup Complete!');

  const webhooksEnabled = env.get('WEBHOOK_ENABLED') === 'true';
  const hasOAuth = env.get('LINEAR_CLIENT_ID') && env.get('LINEAR_CLIENT_SECRET');
  const tokenExists = fs.existsSync(TOKEN_PATH) || fs.existsSync(LEGACY_TOKEN_PATH);
  const webhookSecret = env.get('LINEAR_WEBHOOK_SECRET');

  console.log(`${colors.bold}Next Steps:${colors.reset}\n`);

  let step = 1;

  if (hasOAuth && !tokenExists) {
    console.log(`  ${step}. Complete OAuth authorization:`);
    console.log(`     ${colors.cyan}npm run auth${colors.reset}\n`);
    step++;
  }

  if (webhooksEnabled && webhookSecret) {
    console.log(`  ${step}. Keep ngrok running in a separate terminal:`);
    console.log(`     ${colors.cyan}ngrok http ${env.get('WEBHOOK_PORT') || '3000'}${colors.reset}`);
    console.log(`     ${colors.dim}(If you closed it, restart it and update the webhook URL in Linear)${colors.reset}\n`);
    step++;

    console.log(`  ${step}. Verify Linear webhook is configured:`);
    console.log(`     - URL should point to your ngrok tunnel + /webhook`);
    console.log(`     - Webhook secret should match the one in .env`);
    console.log(`     - Events should include Issue and Comment changes\n`);
    step++;
  }

  console.log(`  ${step}. Start TaskAgent:`);
  console.log(`     ${colors.cyan}npm run dev${colors.reset}\n`);
  step++;

  if (webhooksEnabled) {
    console.log(`${colors.yellow}Note:${colors.reset} ${colors.dim}With webhooks enabled, TaskAgent will receive real-time updates from Linear.
If ngrok restarts and you get a new URL, remember to update the webhook URL in Linear.${colors.reset}\n`);
  }

  console.log(`${colors.dim}For more information, see the README.md${colors.reset}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  rl = createReadline();

  try {
    printHeader();

    // Migrate any legacy files to new .taskagent directory
    migrateLegacyFiles();

    // Step 1: Check prerequisites
    const prereqOk = await checkPrerequisites();
    if (!prereqOk) {
      process.exit(1);
    }

    // Step 2: Setup .env file
    const env = await setupEnvFile();

    // Step 3: Target repository (FIRST - most important)
    // This also analyzes the repo and auto-detects GitHub remote
    const workDir = await setupTargetRepository(env);
    if (!workDir) {
      printError('Target repository is required to continue.');
      process.exit(1);
    }

    // Step 4: Webhook setup (BEFORE OAuth to get ngrok URL)
    const webhookSetup = await setupWebhooks(env);

    // Step 5: Linear authentication (with ngrok URL if webhooks enabled)
    await setupLinearAuth(env, webhookSetup.ngrokUrl);

    // Step 6: Fetch Linear teams
    await fetchLinearTeams(env);

    // Step 7: Anthropic API
    await setupAnthropic(env);

    // Step 8: GitHub configuration (if not auto-detected from repo)
    const existingRepo = env.get('GITHUB_REPO');
    if (!existingRepo || existingRepo === 'owner/repo-name') {
      await setupGitHub(env);
    }

    // Step 9: Agent concurrency settings
    await setupAgentConcurrency(env);

    // Save configuration
    printSection('Saving Configuration');
    saveEnvFile(env);
    printSuccess('.env file saved');

    // Step 10: Install dependencies
    await installDependencies();

    // Step 11: OAuth flow (if applicable)
    await runOAuthFlow(env);

    // Reload env after OAuth might have fetched team info
    const finalEnv = loadEnvFile();

    // Step 12: Create trigger labels
    await createTriggerLabels(finalEnv);

    // Step 13: Verify
    const verified = verifySetup(finalEnv);

    // Step 14: Next steps
    printNextSteps(finalEnv);

    if (!verified) {
      console.log(`${colors.yellow}Some configuration may be incomplete. Please review the warnings above.${colors.reset}\n`);
    }

  } catch (error) {
    if (error instanceof Error && error.message === 'readline was closed') {
      console.log('\n\nSetup cancelled.');
    } else {
      printError(`Setup failed: ${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
