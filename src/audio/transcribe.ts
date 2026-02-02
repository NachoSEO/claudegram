import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { downloadFileSecure, getTelegramFileUrl } from '../utils/download.js';
import { getProxyDispatcher } from '../utils/proxy.js';

const GROQ_WHISPER_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

export interface TranscribeOptions {
  /** Timeout in milliseconds. Defaults to config.VOICE_TIMEOUT_MS */
  timeoutMs?: number;
  /** If true, return empty string instead of throwing on empty result */
  allowEmpty?: boolean;
}

/**
 * Build the FormData for a Groq Whisper transcription request.
 */
function buildFormData(fileBuffer: Buffer, fileName: string): FormData {
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('model', GROQ_WHISPER_MODEL);
  formData.append('language', config.VOICE_LANGUAGE);
  formData.append('response_format', 'json');
  return formData;
}

/**
 * Transcribe an audio file using the Groq Whisper API directly via fetch.
 * If the request gets a 403 (VPN/IP block), automatically retries through
 * a residential proxy when VOICE_PROXY_ENABLED is true and proxies are configured.
 */
export async function transcribeFile(filePath: string, options?: TranscribeOptions): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
  }

  const timeoutMs = options?.timeoutMs ?? config.VOICE_TIMEOUT_MS;
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // First attempt — direct connection
  const formData = buildFormData(fileBuffer, fileName);

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  };

  let response = await fetch(GROQ_WHISPER_ENDPOINT, fetchOptions);

  // On 403, retry through residential proxy
  if (response.status === 403 && config.VOICE_PROXY_ENABLED) {
    const dispatcher = getProxyDispatcher();
    if (dispatcher) {
      console.log('[Transcribe] Got 403 — retrying through residential proxy');
      const retryFormData = buildFormData(fileBuffer, fileName);
      response = await fetch(GROQ_WHISPER_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.GROQ_API_KEY}`,
        },
        body: retryFormData,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      } as RequestInit);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Whisper API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as { text?: string };
  const transcript = (result.text || '').trim();

  if (!transcript && !options?.allowEmpty) {
    throw new Error('Empty transcription result');
  }

  return transcript;
}

/**
 * Download a file from Telegram servers securely.
 * Constructs the URL via getTelegramFileUrl and delegates to downloadFileSecure.
 */
export function downloadTelegramAudio(botToken: string, filePath: string, destPath: string): Promise<void> {
  const fileUrl = getTelegramFileUrl(botToken, filePath);
  return downloadFileSecure(fileUrl, destPath);
}
