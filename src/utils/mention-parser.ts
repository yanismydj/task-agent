/**
 * Parse @taskAgent mentions from Linear comments.
 * Extracts the command word following the mention.
 */

export type TaskAgentCommand = 'clarify' | 'rewrite' | 'work' | 'help';

export interface ParsedMention {
  found: boolean;
  command: TaskAgentCommand | null;
  rawText: string;
}

const VALID_COMMANDS = ['clarify', 'rewrite', 'work'] as const;

/**
 * Parse a comment body for @taskAgent mentions.
 *
 * @param commentBody - The raw comment text from Linear
 * @returns ParsedMention with found=true if mention detected
 *
 * Examples:
 *   "@taskAgent clarify" -> { found: true, command: 'clarify' }
 *   "@taskagent work"    -> { found: true, command: 'work' }
 *   "@TaskAgent"         -> { found: true, command: 'help' }
 *   "@taskAgent unknown"  -> { found: true, command: 'help' }
 *   "hello world"        -> { found: false, command: null }
 */
export function parseMention(commentBody: string): ParsedMention {
  // Match @taskagent (case-insensitive), optionally followed by whitespace and a word
  const mentionRegex = /@taskagent\s*(\w*)/i;
  const match = commentBody.match(mentionRegex);

  if (!match) {
    return { found: false, command: null, rawText: '' };
  }

  const commandWord = match[1]?.toLowerCase() || '';

  // Map to valid commands, default to 'help' for unknown/empty
  const command: TaskAgentCommand = VALID_COMMANDS.includes(
    commandWord as (typeof VALID_COMMANDS)[number]
  )
    ? (commandWord as TaskAgentCommand)
    : 'help';

  return { found: true, command, rawText: match[0] };
}

/**
 * Get the help text to display when user sends empty mention or unknown command.
 */
export function getHelpText(): string {
  return `**TaskAgent Commands**

- \`@taskAgent clarify\` - Ask clarifying questions to understand requirements
- \`@taskAgent rewrite\` - Consolidate discussion into an updated description
- \`@taskAgent work\` - Start implementing this ticket

Mention me without a command to see this help.`;
}
