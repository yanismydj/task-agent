import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ module: 'prompt-cache' });

/**
 * Save a prompt to the cached prompts directory in debug mode
 */
export function savePromptToCache(ticketIdentifier: string, prompt: string): string | null {
  if (!config.debug.enabled) {
    return null;
  }

  try {
    const cacheDir = path.resolve(config.agents.workDir, config.debug.cachePromptsDir);

    // Create directory if it doesn't exist
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      logger.info({ cacheDir }, 'Created cached prompts directory');
    }

    // Generate filename with ticket ID and timestamp
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const filename = `${ticketIdentifier}_${timestamp}.txt`;
    const filepath = path.join(cacheDir, filename);

    // Write prompt to file
    fs.writeFileSync(filepath, prompt, 'utf-8');
    logger.info({ filepath, ticketId: ticketIdentifier }, 'Saved prompt to cache');

    return filepath;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, ticketId: ticketIdentifier }, 'Failed to save prompt to cache');
    return null;
  }
}

/**
 * Format a prompt for inclusion in a Linear comment with proper formatting
 */
export function formatPromptForComment(prompt: string): string {
  // Use a collapsible details section for long prompts
  const lines = prompt.split('\n');

  if (lines.length > 20 || prompt.length > 1000) {
    // Long prompt - use collapsible section
    return `<details>
<summary>📋 View Full Prompt (${lines.length} lines)</summary>

\`\`\`
${prompt}
\`\`\`

</details>`;
  } else {
    // Short prompt - use code block
    return `**Prompt:**
\`\`\`
${prompt}
\`\`\``;
  }
}
