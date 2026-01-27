import { execFile } from 'child_process';
import * as path from 'path';
import { config } from '../config.js';

/**
 * Extract the transcript text from groq_transcribe.py stdout.
 * The script prints "Full text:\n<text>" as the last output.
 */
export function parseTranscript(stdout: string): string {
  const marker = 'Full text:\n';
  const idx = stdout.lastIndexOf(marker);
  if (idx !== -1) {
    return stdout.slice(idx + marker.length).trim();
  }
  // Fallback: return the last non-empty line
  const lines = stdout.trim().split('\n').filter((l) => l.trim());
  return lines[lines.length - 1] || '';
}

/**
 * Transcribe an audio file using groq_transcribe.py.
 * Returns the transcript text.
 */
export function transcribeFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      config.GROQ_TRANSCRIBE_PATH,
      filePath,
      '--task', 'transcribe',
      '--language', config.VOICE_LANGUAGE,
    ];

    const env = { ...process.env };
    if (config.GROQ_API_KEY) {
      env.GROQ_API_KEY = config.GROQ_API_KEY;
    }

    execFile(
      'python3',
      args,
      {
        timeout: config.VOICE_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        cwd: path.dirname(config.GROQ_TRANSCRIBE_PATH),
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText = (stderr || '').trim();
          if (stderrText.includes('GROQ_API_KEY')) {
            reject(new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.'));
          } else if (stderrText.includes('ModuleNotFoundError')) {
            const modMatch = stderrText.match(/No module named '(\w+)'/);
            reject(new Error(`Missing Python dependency: ${modMatch ? modMatch[1] : 'unknown'}`));
          } else if ((error as { killed?: boolean }).killed) {
            reject(new Error('Transcription timed out.'));
          } else {
            reject(new Error(stderrText || error.message));
          }
          return;
        }

        const transcript = parseTranscript(stdout || '');
        if (!transcript) {
          reject(new Error('Empty transcription result'));
          return;
        }
        resolve(transcript);
      }
    );
  });
}

/**
 * Download a file from Telegram servers using curl (with retry).
 */
export function downloadTelegramAudio(
  botToken: string,
  filePath: string,
  destPath: string
): Promise<void> {
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sS', '-f', '--connect-timeout', '10', '--max-time', '30',
       '--retry', '2', '--retry-delay', '2',
       '-o', destPath,
       fileUrl],
      { timeout: 60_000 },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`Failed to download audio file: ${msg}`));
        } else {
          resolve();
        }
      }
    );
  });
}
