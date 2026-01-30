import * as os from 'os';

const HOME_DIR = os.homedir();
let USERNAME = '';
try { USERNAME = os.userInfo().username; } catch { USERNAME = ''; }

/**
 * Sanitize a string by replacing sensitive paths and usernames.
 * Useful for error messages and logs to prevent information leakage.
 */
export function sanitizePath(str: string): string {
  if (!str) return str;

  let sanitized = str;

  // Replace home directory with ~
  if (HOME_DIR) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(HOME_DIR), 'g'), '~');
  }

  // Replace username if it appears in paths
  if (USERNAME && USERNAME.length > 2) {
    // Only replace in path-like contexts to avoid false positives
    sanitized = sanitized.replace(
      new RegExp(`/Users/${escapeRegExp(USERNAME)}`, 'g'),
      '/Users/<user>'
    );
    sanitized = sanitized.replace(
      new RegExp(`/home/${escapeRegExp(USERNAME)}`, 'g'),
      '/home/<user>'
    );
  }

  return sanitized;
}

/**
 * Sanitize an error for logging.
 * Preserves error type but sanitizes the message.
 */
export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return sanitizePath(error.message);
  }
  if (typeof error === 'string') {
    return sanitizePath(error);
  }
  return 'Unknown error';
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
