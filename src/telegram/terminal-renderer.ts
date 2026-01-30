/**
 * Terminal-style rendering for Telegram messages.
 * Provides emoji icons, spinners, and progress indicators for a terminal-like experience.
 */

// Tool icons (emoji-based for mobile friendliness)
export const TOOL_ICONS: Record<string, string> = {
  // File operations
  Read: '📖',
  Write: '✏️',
  Edit: '🔧',

  // Search and navigation
  Grep: '🔍',
  Glob: '📁',

  // Execution
  Bash: '💻',
  Task: '📋',

  // Web
  WebFetch: '🌐',
  WebSearch: '🔎',

  // Notebook
  NotebookEdit: '📓',

  // Status indicators
  thinking: '💭',
  complete: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

// Spinner frames for animation (Braille pattern spinner)
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Alternative spinner (dots)
export const DOTS_SPINNER = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'];

// Progress bar characters
export const PROGRESS = {
  empty: '░',
  filled: '█',
  partial: '▓',
};

/**
 * Get icon for a tool name
 */
export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || '🔹';
}

/**
 * Get current spinner frame based on index
 */
export function getSpinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length];
}

/**
 * Render a status line showing current operation
 * Example: "⠹ 📖 Reading src/config.ts..."
 */
export function renderStatusLine(
  spinnerIndex: number,
  icon: string,
  operation: string,
  detail?: string
): string {
  const spinner = getSpinnerFrame(spinnerIndex);
  const detailStr = detail ? ` ${detail}` : '';
  return `${spinner} ${icon} ${operation}${detailStr}`;
}

/**
 * Render a progress bar
 * Example: "[████████░░░░] 67%"
 */
export function renderProgressBar(percent: number, width: number = 12): string {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clampedPercent / 100) * width);
  const emptyCount = width - filledCount;

  const filled = PROGRESS.filled.repeat(filledCount);
  const empty = PROGRESS.empty.repeat(emptyCount);

  return `[${filled}${empty}] ${Math.round(clampedPercent)}%`;
}

/**
 * Render a tool operation status
 * Example: "📖 Read → src/config.ts"
 */
export function renderToolOperation(toolName: string, detail?: string): string {
  const icon = getToolIcon(toolName);
  const action = getToolAction(toolName);
  const detailStr = detail ? ` → ${detail}` : '';
  return `${icon} ${action}${detailStr}`;
}

/**
 * Get human-readable action name for a tool
 */
function getToolAction(toolName: string): string {
  const actions: Record<string, string> = {
    Read: 'Reading',
    Write: 'Writing',
    Edit: 'Editing',
    Bash: 'Running',
    Grep: 'Searching',
    Glob: 'Finding',
    Task: 'Task',
    WebFetch: 'Fetching',
    WebSearch: 'Searching',
    NotebookEdit: 'Editing notebook',
  };
  return actions[toolName] || toolName;
}

/**
 * Extract a meaningful detail from tool input for display
 */
export function extractToolDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return truncatePath(input.file_path as string);
    case 'Bash':
      return truncateCommand(input.command as string);
    case 'Grep':
      return input.pattern as string;
    case 'Glob':
      return input.pattern as string;
    case 'WebFetch':
    case 'WebSearch':
      return truncateUrl(input.url as string || input.query as string);
    case 'Task':
      return input.description as string;
    default:
      return undefined;
  }
}

/**
 * Truncate a file path for display
 */
function truncatePath(filePath: string | undefined, maxLen: number = 40): string | undefined {
  if (!filePath) return undefined;
  if (filePath.length <= maxLen) return filePath;

  // Keep the last part of the path
  const parts = filePath.split('/');
  let result = parts[parts.length - 1];

  // Add parent dirs if space allows
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `.../${parts.slice(i).join('/')}`;
    if (candidate.length <= maxLen) {
      result = candidate;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Truncate a command for display
 */
function truncateCommand(command: string | undefined, maxLen: number = 50): string | undefined {
  if (!command) return undefined;
  const firstLine = command.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.substring(0, maxLen - 3) + '...';
}

/**
 * Truncate a URL for display
 */
function truncateUrl(url: string | undefined, maxLen: number = 40): string | undefined {
  if (!url) return undefined;
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + '...';
}

/**
 * Render a background task status line
 * Example: "📋 Background: Installing dependencies ✅"
 */
export function renderBackgroundTask(
  name: string,
  status: 'running' | 'complete' | 'error'
): string {
  const statusIcon = status === 'complete'
    ? TOOL_ICONS.complete
    : status === 'error'
      ? TOOL_ICONS.error
      : getSpinnerFrame(0);
  return `📋 Background: ${name} ${statusIcon}`;
}

/**
 * Format a terminal-style message with optional status and background tasks
 */
export function formatTerminalMessage(
  content: string,
  options: {
    spinnerIndex?: number;
    currentOperation?: { icon: string; name: string; detail?: string };
    backgroundTasks?: Array<{ name: string; status: 'running' | 'complete' | 'error' }>;
    isComplete?: boolean;
  } = {}
): string {
  const { spinnerIndex = 0, currentOperation, backgroundTasks = [], isComplete = false } = options;

  const parts: string[] = [];

  // Add status line if there's a current operation and not complete
  if (currentOperation && !isComplete) {
    parts.push(renderStatusLine(
      spinnerIndex,
      currentOperation.icon,
      currentOperation.name,
      currentOperation.detail
    ));
    parts.push('');
  }

  // Add main content
  if (content) {
    parts.push(content);
  }

  // Add background tasks if any
  if (backgroundTasks.length > 0) {
    if (content) parts.push('');
    for (const task of backgroundTasks) {
      parts.push(renderBackgroundTask(task.name, task.status));
    }
  }

  return parts.join('\n');
}
