export interface ParsedCommand {
  command: string | null;
  args: string;
  model: string | null;
}

const CLAUDE_COMMANDS = ['plan', 'explore', 'model', 'commands', 'loop', 'resume', 'continue', 'sessions'] as const;
type ClaudeCommand = (typeof CLAUDE_COMMANDS)[number];

export function parseClaudeCommand(message: string): ParsedCommand {
  const trimmed = message.trim();

  // Check if message starts with a slash command
  if (!trimmed.startsWith('/')) {
    return { command: null, args: trimmed, model: null };
  }

  const firstSpace = trimmed.indexOf(' ');
  const commandPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  // Check if it's a Claude command
  if (CLAUDE_COMMANDS.includes(commandPart as ClaudeCommand)) {
    return { command: commandPart, args, model: null };
  }

  // Not a recognized Claude command - return as regular message
  return { command: null, args: trimmed, model: null };
}

export function isClaudeCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return false;

  const firstSpace = trimmed.indexOf(' ');
  const commandPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);

  return CLAUDE_COMMANDS.includes(commandPart as ClaudeCommand);
}

// Returns MarkdownV2 escaped command list
export function getAvailableCommands(): string {
  return `*Claude Commands:*

• \`/plan <task>\` \\- Enter plan mode for complex tasks
• \`/explore <question>\` \\- Use explore agent for codebase questions
• \`/loop <task>\` \\- Run iteratively until task complete
• \`/model \\[name\\]\` \\- Show or set Claude model
• \`/commands\` \\- Show this list

*Session Commands:*

• \`/project <path>\` \\- Set working directory
• \`/newproject <name>\` \\- Create a new project
• \`/resume\` \\- Pick from recent sessions to resume
• \`/continue\` \\- Resume most recent session
• \`/sessions\` \\- List all sessions
• \`/clear\` \\- Clear session and start fresh
• \`/status\` \\- Show current session info

*File Commands:*

• \`/file <path>\` \\- Download a file from project
• \`/telegraph <path>\` \\- View markdown with Instant View

*Reddit Commands:*

• \`/reddit <target>\` \\- Fetch Reddit posts, subreddits, or user profiles

*Bot Commands:*

• \`/tts\` \\- Toggle voice replies
• \`/ping\` \\- Check if bot is responsive
• \`/cancel\` \\- Cancel current request
• \`/mode\` \\- Toggle streaming mode`;
}
