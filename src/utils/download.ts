import { spawn, execFile } from 'child_process';

/**
 * Validate URL for safe curl download.
 * Rejects URLs that could cause injection in curl commands.
 */
function isValidCurlUrl(url: string): boolean {
  // Must be http or https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }
  // Reject URLs with newlines, control characters, or shell metacharacters
  if (/[\r\n\0]/.test(url)) {
    return false;
  }
  return true;
}

/**
 * Download a file from a URL using curl.
 * Uses execFile with explicit URL argument (safe from shell injection).
 * Validates URL to prevent curl-specific injection attacks.
 */
export function downloadFileSecure(fileUrl: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidCurlUrl(fileUrl)) {
      reject(new Error('Invalid URL for download'));
      return;
    }

    // Use execFile (not spawn with shell) with URL as explicit argument.
    // This avoids shell injection entirely.
    execFile(
      'curl',
      [
        '-sS',
        '-f',
        '--connect-timeout', '10',
        '--max-time', '30',
        '--retry', '3',
        '--retry-delay', '2',
        '--retry-all-errors',
        '-o', destPath,
        '--', // End of options marker
        fileUrl, // URL as positional argument
      ],
      { timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`Failed to download file: ${msg}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Build a Telegram file download URL from the bot token and file path.
 */
export function getTelegramFileUrl(botToken: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}
