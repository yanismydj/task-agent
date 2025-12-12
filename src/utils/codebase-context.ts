import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from './logger.js';
import type { LinearApiClient } from '../linear/client.js';

const logger = createChildLogger({ module: 'codebase-context' });

// In-memory cache with TTL
interface CacheEntry {
  context: string;
  cachedAt: Date;
}

const filesystemCache = new Map<string, CacheEntry>();
const linearCache = new Map<string, CacheEntry>();

const FILESYSTEM_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const LINEAR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Directories to exclude when scanning
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.task-agent',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.turbo',
]);

// Files that might contain secrets (don't read content) - reserved for future use
// const SENSITIVE_FILES = new Set([
//   '.env', '.env.local', '.env.production', '.env.development',
//   'credentials.json', 'secrets.json', '.npmrc', '.pypirc',
// ]);

interface PackageJsonInfo {
  name?: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
  engines?: Record<string, string>;
}

interface DirectoryInfo {
  sourceDir?: string;
  testDir?: string;
  configFiles: string[];
  hasTypeScript: boolean;
  hasDocker: boolean;
}

/**
 * Build dynamic codebase context from filesystem and Linear
 */
export async function buildCodebaseContext(
  workDir: string,
  linearClient: LinearApiClient,
  ticketId: string
): Promise<string> {
  const sections: string[] = [];

  // Get filesystem context (cached)
  const filesystemContext = await getFilesystemContext(workDir);
  if (filesystemContext) {
    sections.push(filesystemContext);
  }

  // Get Linear context (cached)
  const linearContext = await getLinearContext(linearClient, ticketId);
  if (linearContext) {
    sections.push(linearContext);
  }

  // Add guidelines section
  sections.push(buildGuidelinesSection(filesystemContext));

  return sections.join('\n\n');
}

/**
 * Get filesystem context with caching
 */
async function getFilesystemContext(workDir: string): Promise<string | null> {
  // Check cache
  const cached = filesystemCache.get(workDir);
  if (cached && Date.now() - cached.cachedAt.getTime() < FILESYSTEM_CACHE_TTL_MS) {
    logger.debug({ workDir }, 'Using cached filesystem context');
    return cached.context;
  }

  try {
    const packageInfo = await getPackageJsonContext(workDir);
    const readmeInfo = await getReadmeContext(workDir);
    const dirInfo = await getDirectoryStructure(workDir);

    const sections: string[] = [];

    // Project header
    if (packageInfo?.name) {
      sections.push(`## Project: ${packageInfo.name}`);
      if (packageInfo.description) {
        sections.push(packageInfo.description);
      }
    }

    // README summary
    if (readmeInfo) {
      sections.push(`\n### About\n${readmeInfo}`);
    }

    // Tech stack
    const techStack = buildTechStackSection(packageInfo, dirInfo);
    if (techStack) {
      sections.push(techStack);
    }

    // Architecture
    const architecture = buildArchitectureSection(dirInfo);
    if (architecture) {
      sections.push(architecture);
    }

    const context = sections.join('\n');

    // Cache the result
    filesystemCache.set(workDir, { context, cachedAt: new Date() });
    logger.info({ workDir }, 'Built and cached filesystem context');

    return context;
  } catch (error) {
    logger.warn({ workDir, error }, 'Failed to build filesystem context');
    return null;
  }
}

/**
 * Parse package.json for project info
 */
async function getPackageJsonContext(workDir: string): Promise<PackageJsonInfo | null> {
  const packagePath = path.join(workDir, 'package.json');

  try {
    if (!fs.existsSync(packagePath)) {
      return null;
    }

    const content = fs.readFileSync(packagePath, 'utf-8');
    const pkg = JSON.parse(content);

    return {
      name: pkg.name,
      description: pkg.description,
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {}),
      scripts: Object.keys(pkg.scripts || {}),
      engines: pkg.engines,
    };
  } catch (error) {
    logger.debug({ workDir, error }, 'Failed to parse package.json');
    return null;
  }
}

/**
 * Extract README summary (first 500 chars of content)
 */
async function getReadmeContext(workDir: string): Promise<string | null> {
  const readmeNames = ['README.md', 'readme.md', 'README', 'README.txt'];

  for (const name of readmeNames) {
    const readmePath = path.join(workDir, name);
    try {
      if (fs.existsSync(readmePath)) {
        const content = fs.readFileSync(readmePath, 'utf-8');
        // Extract first meaningful paragraph (skip title)
        const lines = content.split('\n');
        const paragraphs: string[] = [];
        let inParagraph = false;

        for (const line of lines) {
          const trimmed = line.trim();
          // Skip headers and badges
          if (trimmed.startsWith('#') || trimmed.startsWith('![') || trimmed.startsWith('[![')) {
            continue;
          }
          if (trimmed.length > 0) {
            paragraphs.push(trimmed);
            inParagraph = true;
          } else if (inParagraph) {
            break; // End of first paragraph
          }
        }

        const summary = paragraphs.join(' ').slice(0, 500);
        return summary.length > 0 ? summary : null;
      }
    } catch {
      // Continue to next README variant
    }
  }

  return null;
}

/**
 * Scan directory structure for architecture info
 */
async function getDirectoryStructure(workDir: string): Promise<DirectoryInfo> {
  const info: DirectoryInfo = {
    configFiles: [],
    hasTypeScript: false,
    hasDocker: false,
  };

  try {
    const entries = fs.readdirSync(workDir, { withFileTypes: true });

    for (const entry of entries) {
      const name = entry.name;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;

        // Detect source directories
        if (['src', 'lib', 'app', 'source'].includes(name)) {
          info.sourceDir = name;
        }

        // Detect test directories
        if (['test', 'tests', '__tests__', 'spec', 'specs'].includes(name)) {
          info.testDir = name;
        }
      } else if (entry.isFile()) {
        // Config files
        if (name === 'tsconfig.json') {
          info.hasTypeScript = true;
          info.configFiles.push('TypeScript');
        }
        if (name === 'Dockerfile' || name === 'docker-compose.yml') {
          info.hasDocker = true;
          info.configFiles.push('Docker');
        }
        if (name.includes('eslint') || name === '.eslintrc.json' || name === '.eslintrc.js') {
          info.configFiles.push('ESLint');
        }
        if (name.includes('prettier') || name === '.prettierrc') {
          info.configFiles.push('Prettier');
        }
        if (name === 'jest.config.js' || name === 'jest.config.ts') {
          info.configFiles.push('Jest');
        }
        if (name === 'vitest.config.ts' || name === 'vitest.config.js') {
          info.configFiles.push('Vitest');
        }
      }
    }
  } catch (error) {
    logger.debug({ workDir, error }, 'Failed to scan directory structure');
  }

  return info;
}

/**
 * Build tech stack section from package.json and directory info
 */
function buildTechStackSection(pkg: PackageJsonInfo | null, dir: DirectoryInfo): string | null {
  const stack: string[] = [];

  // Runtime/Language
  if (dir.hasTypeScript) {
    stack.push('- **Language**: TypeScript');
  } else if (pkg?.dependencies.includes('typescript') || pkg?.devDependencies.includes('typescript')) {
    stack.push('- **Language**: TypeScript');
  }

  // Framework detection from dependencies
  const allDeps = [...(pkg?.dependencies || []), ...(pkg?.devDependencies || [])];

  if (allDeps.includes('react') || allDeps.includes('react-dom')) {
    stack.push('- **Framework**: React');
  }
  if (allDeps.includes('next')) {
    stack.push('- **Framework**: Next.js');
  }
  if (allDeps.includes('express')) {
    stack.push('- **Server**: Express.js');
  }
  if (allDeps.includes('fastify')) {
    stack.push('- **Server**: Fastify');
  }
  if (allDeps.includes('nestjs') || allDeps.includes('@nestjs/core')) {
    stack.push('- **Framework**: NestJS');
  }

  // Database detection
  if (allDeps.includes('prisma') || allDeps.includes('@prisma/client')) {
    stack.push('- **ORM**: Prisma');
  }
  if (allDeps.includes('mongoose')) {
    stack.push('- **Database**: MongoDB (Mongoose)');
  }
  if (allDeps.includes('pg') || allDeps.includes('postgres')) {
    stack.push('- **Database**: PostgreSQL');
  }
  if (allDeps.includes('better-sqlite3') || allDeps.includes('sqlite3')) {
    stack.push('- **Database**: SQLite');
  }

  // Testing
  if (allDeps.includes('jest')) {
    stack.push('- **Testing**: Jest');
  }
  if (allDeps.includes('vitest')) {
    stack.push('- **Testing**: Vitest');
  }
  if (allDeps.includes('mocha')) {
    stack.push('- **Testing**: Mocha');
  }

  if (stack.length === 0) {
    return null;
  }

  return `### Tech Stack\n${stack.join('\n')}`;
}

/**
 * Build architecture section from directory info
 */
function buildArchitectureSection(dir: DirectoryInfo): string | null {
  const parts: string[] = [];

  if (dir.sourceDir) {
    parts.push(`- **Source**: \`${dir.sourceDir}/\``);
  }
  if (dir.testDir) {
    parts.push(`- **Tests**: \`${dir.testDir}/\``);
  }
  if (dir.configFiles.length > 0) {
    parts.push(`- **Tooling**: ${dir.configFiles.join(', ')}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `### Architecture\n${parts.join('\n')}`;
}

/**
 * Get Linear context (project info, related tickets)
 */
async function getLinearContext(
  linearClient: LinearApiClient,
  ticketId: string
): Promise<string | null> {
  // Check cache
  const cacheKey = `linear-${ticketId}`;
  const cached = linearCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt.getTime() < LINEAR_CACHE_TTL_MS) {
    logger.debug({ ticketId }, 'Using cached Linear context');
    return cached.context;
  }

  try {
    const sections: string[] = ['### Linear Context'];

    // Get ticket info to find project
    const ticket = await linearClient.getTicketCached(ticketId);
    if (ticket) {
      // Get recent completed tickets for patterns (limit to 3)
      const completedTickets = getRecentCompletedTickets(linearClient, 3);
      if (completedTickets.length > 0) {
        sections.push('\n**Recent completed work:**');
        for (const t of completedTickets) {
          sections.push(`- ${t.identifier}: ${t.title.slice(0, 60)}${t.title.length > 60 ? '...' : ''}`);
        }
      }
    }

    if (sections.length === 1) {
      return null; // No meaningful context gathered
    }

    const context = sections.join('\n');

    // Cache the result
    linearCache.set(cacheKey, { context, cachedAt: new Date() });
    logger.info({ ticketId }, 'Built and cached Linear context');

    return context;
  } catch (error) {
    logger.warn({ ticketId, error }, 'Failed to build Linear context');
    return null;
  }
}

/**
 * Get recent completed tickets for pattern reference
 */
function getRecentCompletedTickets(
  linearClient: LinearApiClient,
  limit: number
): Array<{ identifier: string; title: string }> {
  try {
    // Use cached tickets and filter for completed (synchronous - no API call)
    const tickets = linearClient.getCachedTickets();
    const completed = tickets
      .filter((t) => t.state.type === 'completed')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);

    return completed.map((t) => ({
      identifier: t.identifier,
      title: t.title,
    }));
  } catch {
    return [];
  }
}

/**
 * Build guidelines section based on discovered tech stack
 */
function buildGuidelinesSection(filesystemContext: string | null): string {
  const doNotAsk: string[] = [];
  const focusOn: string[] = [
    'Business logic decisions',
    'User experience choices',
    'Edge cases and error handling preferences',
    'Scope clarification (what\'s in/out of scope)',
  ];

  // Parse discovered tech from filesystem context
  if (filesystemContext) {
    if (filesystemContext.includes('TypeScript')) {
      doNotAsk.push('Language choice (TypeScript is already used)');
    }
    if (filesystemContext.includes('React') || filesystemContext.includes('Next.js')) {
      doNotAsk.push('Frontend framework (React/Next.js is already used)');
    }
    if (filesystemContext.includes('Express') || filesystemContext.includes('Fastify') || filesystemContext.includes('NestJS')) {
      doNotAsk.push('Backend framework (already established)');
    }
    if (filesystemContext.includes('Database:') || filesystemContext.includes('ORM:')) {
      doNotAsk.push('Database/ORM choice (already established)');
    }
    if (filesystemContext.includes('Testing:')) {
      doNotAsk.push('Testing framework (already established)');
    }
  }

  if (doNotAsk.length === 0) {
    doNotAsk.push('Technology choices evident from the codebase');
  }

  return `### Guidelines for Questions

**DO NOT ask about:**
${doNotAsk.map((item) => `- ${item}`).join('\n')}

**FOCUS questions on:**
${focusOn.map((item) => `- ${item}`).join('\n')}`;
}

/**
 * Clear all caches (useful for testing or forced refresh)
 */
export function clearContextCaches(): void {
  filesystemCache.clear();
  linearCache.clear();
  logger.info('Cleared all context caches');
}
