import { spawn } from 'child_process';

/**
 * Download a file from a URL using curl with stdin config.
 * Prevents token exposure in process args (visible via `ps aux`).
 */
export function downloadFileSecure(fileUrl: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const curlArgs = [
      '-sS',
      '-f',
      '--connect-timeout',
      '10',
      '--max-time',
      '30',
      '--retry',
      '2',
      '--retry-delay',
      '2',
      '-o',
      destPath,
      '-K',
      '-', // Read config from stdin
    ];

    const child = spawn('curl', curlArgs, { timeout: 60_000 });
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn curl: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = stderr.trim() || `curl exited with code ${code}`;
        reject(new Error(`Failed to download file: ${msg}`));
      }
    });

    // Write URL via stdin config format to avoid process arg exposure.
    // Sanitize the URL to prevent curl config injection via embedded quotes/newlines.
    const safeUrl = fileUrl.replace(/[\r\n"\\]/g, '');
    child.stdin.write(`url = "${safeUrl}"\n`);
    child.stdin.end();
  });
}

/**
 * Build a Telegram file download URL from the bot token and file path.
 */
export function getTelegramFileUrl(botToken: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}
