import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config.js';
import { transcribeFile } from '../audio/transcribe.js';
import { sanitizeError, sanitizePath } from '../utils/sanitize.js';

// ── Types ──────────────────────────────────────────────────────────

export type Platform = 'youtube' | 'instagram' | 'tiktok' | 'unknown';

export type ExtractMode = 'text' | 'audio' | 'video' | 'all';

export type SubtitleFormat = 'text' | 'srt' | 'vtt';

export interface ExtractResult {
  platform: Platform;
  title: string;
  url: string;
  duration: number | null; // seconds
  transcript?: string;
  subtitlePath?: string; // for SRT/VTT file delivery
  subtitleFormat?: SubtitleFormat;
  audioPath?: string;
  videoPath?: string;
  warnings: string[];
  /** @internal temp dir for cleanup */
  _tempDir?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_GROQ_FILE_SIZE_MB = 25; // Groq free tier limit
const CHUNK_DURATION_SEC = 600; // 10 min chunks for large audio
const YTDLP_TIMEOUT_MS = 180_000; // 3 min
const FFMPEG_TIMEOUT_MS = 120_000; // 2 min
const FFPROBE_TIMEOUT_MS = 15_000;
const TELEGRAM_VIDEO_MAX_MB = 50;

// Errors that indicate IP block or auth issue — triggers proxy retry
const PROXY_RETRY_PATTERNS = [
  /ip.+block/i,
  /not comfortable for some audiences/i,
  /log in for access/i,
  /blocked from accessing/i,
  /access denied/i,
  /403/,
];

function shouldRetryWithProxy(errorMsg: string): boolean {
  return PROXY_RETRY_PATTERNS.some(p => p.test(errorMsg));
}

// ── Platform Detection ─────────────────────────────────────────────

const PLATFORM_PATTERNS: { platform: Platform; pattern: RegExp }[] = [
  { platform: 'youtube', pattern: /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i },
  { platform: 'instagram', pattern: /(?:instagram\.com|instagr\.am)/i },
  { platform: 'tiktok', pattern: /(?:tiktok\.com|vm\.tiktok\.com)/i },
];

export function detectPlatform(url: string): Platform {
  for (const { platform, pattern } of PLATFORM_PATTERNS) {
    if (pattern.test(url)) return platform;
  }
  return 'unknown';
}

/**
 * Validate a URL for safe external fetching.
 * Only allows http/https protocols to prevent SSRF attacks.
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http/https to prevent SSRF attacks (file://, ftp://, etc.)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function platformEmoji(platform: Platform): string {
  switch (platform) {
    case 'youtube': return '\u{25B6}\u{FE0F}';
    case 'instagram': return '\u{1F4F7}';
    case 'tiktok': return '\u{1F3B5}';
    default: return '\u{1F517}';
  }
}

export function platformLabel(platform: Platform): string {
  switch (platform) {
    case 'youtube': return 'YouTube';
    case 'instagram': return 'Instagram';
    case 'tiktok': return 'TikTok';
    default: return 'Unknown';
  }
}

// ── Cookie Support ─────────────────────────────────────────────────

function getCookieArgs(): string[] {
  if (config.YTDLP_COOKIES_PATH && fs.existsSync(config.YTDLP_COOKIES_PATH)) {
    return ['--cookies', config.YTDLP_COOKIES_PATH];
  }
  return [];
}

// ── Proxy Support (fallback only) ──────────────────────────────────

let proxyList: string[] = [];
let proxyIndex = 0;

function loadProxies(): void {
  if (!config.YTDLP_PROXY_LIST_PATH) return;
  try {
    if (fs.existsSync(config.YTDLP_PROXY_LIST_PATH)) {
      proxyList = fs.readFileSync(config.YTDLP_PROXY_LIST_PATH, 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      console.log(`[extract] Loaded ${proxyList.length} proxies from ${config.YTDLP_PROXY_LIST_PATH}`);
    }
  } catch (err) {
    console.warn('[extract] Failed to load proxy list:', err);
  }
}

loadProxies();

function getNextProxy(): string | null {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;
  return proxy;
}

// ── Shell Helpers ──────────────────────────────────────────────────

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${(stderr || '').trim() || error.message}`));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * Run a yt-dlp command with automatic proxy fallback.
 * First tries without proxy. If it fails with an IP/auth error and proxies
 * are available, retries once through a residential proxy.
 */
async function runYtDlp(
  baseArgs: string[],
  timeoutMs: number,
  onRetry?: (msg: string) => void
): Promise<{ stdout: string; stderr: string }> {
  const args = [...baseArgs, ...getCookieArgs()];

  try {
    return await runCommand('yt-dlp', args, timeoutMs);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : '';

    if (shouldRetryWithProxy(errMsg)) {
      const proxy = getNextProxy();
      if (proxy) {
        console.log(`[extract] Retrying with proxy after: ${errMsg.slice(0, 100)}`);
        onRetry?.('\u{1F310} Retrying with proxy...');
        return await runCommand('yt-dlp', [...args, '--proxy', proxy], timeoutMs);
      }
    }

    throw err;
  }
}

// ── Metadata ───────────────────────────────────────────────────────

interface VideoMeta {
  title: string;
  duration: number | null;
}

async function getVideoMeta(url: string, onRetry?: (msg: string) => void): Promise<VideoMeta> {
  try {
    const { stdout } = await runYtDlp([
      '--no-download',
      '--print', '%(title)s\n%(duration)s',
      '--no-playlist',
      '--socket-timeout', '15',
      url,
    ], 30_000, onRetry);

    const lines = stdout.trim().split('\n');
    const title = lines[0] || 'Untitled';
    const duration = lines[1] ? parseFloat(lines[1]) : null;
    return { title, duration: duration && !isNaN(duration) ? duration : null };
  } catch {
    return { title: 'Untitled', duration: null };
  }
}

// ── Audio Download ─────────────────────────────────────────────────

async function downloadAudio(
  url: string,
  outputDir: string,
  onRetry?: (msg: string) => void
): Promise<string> {
  const outputTemplate = path.join(outputDir, 'audio.%(ext)s');

  await runYtDlp([
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', outputTemplate,
    '--no-playlist',
    '--socket-timeout', '30',
    '--retries', '3',
    '--no-warnings',
    url,
  ], YTDLP_TIMEOUT_MS, onRetry);

  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('audio.'));
  if (files.length === 0) {
    throw new Error('yt-dlp produced no audio output');
  }
  return path.join(outputDir, files[0]);
}

// ── Video Download ─────────────────────────────────────────────────

async function downloadVideo(
  url: string,
  outputDir: string,
  onRetry?: (msg: string) => void
): Promise<string> {
  const outputTemplate = path.join(outputDir, 'video.%(ext)s');

  await runYtDlp([
    '-f', 'best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--no-playlist',
    '--socket-timeout', '30',
    '--retries', '3',
    '--no-warnings',
    '--max-filesize', `${TELEGRAM_VIDEO_MAX_MB}M`,
    url,
  ], YTDLP_TIMEOUT_MS, onRetry);

  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('video.'));
  if (files.length === 0) {
    throw new Error('yt-dlp produced no video output');
  }
  return path.join(outputDir, files[0]);
}

// ── YouTube Subtitle Download ──────────────────────────────────────

async function downloadSubtitles(
  url: string,
  outputDir: string,
  format: SubtitleFormat,
  onRetry?: (msg: string) => void
): Promise<string | null> {
  const outputTemplate = path.join(outputDir, 'subs.%(ext)s');
  const subFormat = format === 'text' ? 'vtt' : format; // download as vtt, convert to text later

  try {
    await runYtDlp([
      '--no-download',
      '--write-auto-subs',
      '--write-subs',
      '--sub-langs', 'en.*,en',
      '--sub-format', subFormat,
      '--convert-subs', subFormat,
      '-o', outputTemplate,
      '--no-playlist',
      '--socket-timeout', '15',
      url,
    ], 60_000, onRetry);

    // Find the subtitle file
    const files = fs.readdirSync(outputDir).filter(f =>
      f.startsWith('subs.') && (f.endsWith('.srt') || f.endsWith('.vtt'))
    );
    if (files.length === 0) return null;
    return path.join(outputDir, files[0]);
  } catch {
    return null;
  }
}

/**
 * Convert VTT subtitle content to plain text (strip timestamps and formatting).
 */
function vttToPlainText(vttContent: string): string {
  const lines = vttContent.split('\n');
  const textLines: string[] = [];
  let lastLine = '';

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headers, timestamps, and empty lines
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT') continue;
    if (trimmed.startsWith('Kind:') || trimmed.startsWith('Language:')) continue;
    if (/^\d{2}:\d{2}/.test(trimmed)) continue; // timestamp line
    if (/^\d+$/.test(trimmed)) continue; // sequence number (SRT)
    // Strip HTML tags
    const clean = trimmed.replace(/<[^>]+>/g, '').trim();
    if (!clean) continue;
    // Deduplicate consecutive identical lines (auto-subs repeat)
    if (clean !== lastLine) {
      textLines.push(clean);
      lastLine = clean;
    }
  }

  return textLines.join('\n');
}

// ── Audio Duration ─────────────────────────────────────────────────

async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await runCommand('ffprobe', [
    '-i', filePath,
    '-show_entries', 'format=duration',
    '-v', 'quiet',
    '-of', 'csv=p=0',
  ], FFPROBE_TIMEOUT_MS);

  const duration = parseFloat(stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Invalid audio duration: ${stdout.trim()}`);
  }
  return duration;
}

// ── Audio Chunking ─────────────────────────────────────────────────

async function chunkAudio(
  inputPath: string,
  outputDir: string,
  chunkDurationSec: number
): Promise<string[]> {
  const duration = await getAudioDuration(inputPath);
  const numChunks = Math.ceil(duration / chunkDurationSec);

  if (numChunks <= 1) {
    return [inputPath];
  }

  const chunks: string[] = [];
  for (let i = 0; i < numChunks; i++) {
    const startSec = i * chunkDurationSec;
    const chunkPath = path.join(outputDir, `chunk_${i}.mp3`);

    await runCommand('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ss', String(startSec),
      '-t', String(chunkDurationSec),
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      chunkPath,
    ], FFMPEG_TIMEOUT_MS);

    if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 0) {
      chunks.push(chunkPath);
    }
  }

  if (chunks.length === 0) {
    throw new Error('Audio chunking produced no output');
  }

  return chunks;
}

// ── Transcription ──────────────────────────────────────────────────

async function transcribeAudioFile(
  filePath: string,
  onProgress?: (message: string) => void
): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
  const transcribeOptions = {
    timeoutMs: config.EXTRACT_TRANSCRIBE_TIMEOUT_MS,
    allowEmpty: true,
  };

  if (fileSizeMB > MAX_GROQ_FILE_SIZE_MB) {
    const chunkDir = path.join(path.dirname(filePath), 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });

    const chunks = await chunkAudio(filePath, chunkDir, CHUNK_DURATION_SEC);
    const transcripts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(`\u{1F4DD} Transcribing chunk ${i + 1}/${chunks.length}...`);
      const text = await transcribeFile(chunks[i], transcribeOptions);
      transcripts.push(text);
    }

    return transcripts.join(' ');
  }

  return transcribeFile(filePath, transcribeOptions);
}

// ── Main Extract Function ──────────────────────────────────────────

export interface ExtractOptions {
  url: string;
  mode: ExtractMode;
  subtitleFormat?: SubtitleFormat; // YouTube only: 'text' (default), 'srt', 'vtt'
  onProgress?: (message: string) => void;
}

export async function extractMedia(opts: ExtractOptions): Promise<ExtractResult> {
  const { url, mode, subtitleFormat, onProgress } = opts;
  const platform = detectPlatform(url);
  const emoji = platformEmoji(platform);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-extract-'));

  const result: ExtractResult = {
    platform,
    title: 'Untitled',
    url,
    duration: null,
    warnings: [],
  };

  try {
    // Get metadata
    onProgress?.(`${emoji} Fetching metadata...`);
    const meta = await getVideoMeta(url, onProgress);
    result.title = meta.title;
    result.duration = meta.duration;

    const wantsText = mode === 'text' || mode === 'all';
    const wantsAudio = mode === 'audio' || mode === 'all';
    const wantsVideo = mode === 'video' || mode === 'all';

    // For YouTube with subtitle format, try YouTube's own subtitles first
    const useYouTubeSubs = wantsText && platform === 'youtube' && subtitleFormat;

    if (useYouTubeSubs) {
      onProgress?.(`${emoji} Fetching subtitles (${subtitleFormat.toUpperCase()})...`);
      const subsPath = await downloadSubtitles(url, tempDir, subtitleFormat, onProgress);

      if (subsPath) {
        if (subtitleFormat === 'text') {
          // Convert VTT to plain text
          const vttContent = fs.readFileSync(subsPath, 'utf-8');
          result.transcript = vttToPlainText(vttContent);
        } else {
          // Deliver as file (SRT or VTT)
          result.subtitlePath = subsPath;
          result.subtitleFormat = subtitleFormat;
        }
      } else {
        result.warnings.push('No YouTube subtitles available. Falling back to Whisper transcription.');
        // Fall through to Whisper below
      }
    }

    // Download audio (needed for Whisper transcription or audio delivery)
    const needsAudio = wantsAudio || (wantsText && !result.transcript && !result.subtitlePath);
    if (needsAudio) {
      onProgress?.(`${emoji} Downloading audio...`);
      const audioPath = await downloadAudio(url, tempDir, onProgress);
      result.audioPath = audioPath;

      // Transcribe if text was requested and we don't already have subtitles
      if (wantsText && !result.transcript && !result.subtitlePath) {
        onProgress?.(`${emoji} Transcribing...`);
        const transcript = await transcribeAudioFile(audioPath, onProgress);
        result.transcript = transcript;
      }
    }

    // Download video
    if (wantsVideo) {
      onProgress?.(`${emoji} Downloading video...`);
      try {
        const videoPath = await downloadVideo(url, tempDir, onProgress);
        const videoSize = fs.statSync(videoPath).size;

        if (videoSize > TELEGRAM_VIDEO_MAX_MB * 1024 * 1024) {
          result.warnings.push(
            `Video is ${(videoSize / 1024 / 1024).toFixed(1)}MB — exceeds Telegram's ${TELEGRAM_VIDEO_MAX_MB}MB limit.`
          );
        } else {
          result.videoPath = videoPath;
        }
      } catch (videoErr) {
        const msg = videoErr instanceof Error ? videoErr.message : 'Unknown error';
        result.warnings.push(`Video download failed: ${msg}`);
        console.warn('[extract] Video download failed:', videoErr);

        if (mode === 'video' && !result.audioPath) {
          try {
            onProgress?.(`${emoji} Downloading audio instead...`);
            result.audioPath = await downloadAudio(url, tempDir, onProgress);
            result.warnings.push('Sending audio instead.');
          } catch {
            // Audio fallback also failed
          }
        }
      }
    }

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[extract] Error:', sanitizeError(error));
    throw new Error(msg);
  } finally {
    result._tempDir = tempDir;
  }
}

/**
 * Clean up temp files from an extraction result.
 * Call this AFTER you've sent all files to Telegram.
 */
export function cleanupExtractResult(result: ExtractResult): void {
  if (result._tempDir) {
    const tempDir = result._tempDir;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[extract] Cleanup failed for ${sanitizePath(tempDir)}:`, sanitizeError(e));
    }
    return;
  }

  // Fallback: clean by file paths
  const paths = [result.audioPath, result.videoPath].filter(Boolean) as string[];
  for (const p of paths) {
    try {
      const dir = path.dirname(p);
      if (dir.includes('claudegram-extract-')) {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
    } catch (e) {
      console.warn(`[extract] Cleanup failed for ${sanitizePath(p)}:`, sanitizeError(e));
    }
  }
}
