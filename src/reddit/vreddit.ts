import { Context, InputFile } from 'grammy';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config.js';
import { escapeMarkdownV2 } from '../telegram/markdown.js';

const USER_AGENT = 'claudegram/1.0';
const DASH_FETCH_TIMEOUT_MS = 15000;
const PAGE_FETCH_TIMEOUT_MS = 15000;
const VIDEO_DOWNLOAD_TIMEOUT_SEC = 120;
const FFMPEG_TIMEOUT_MS = 120000;
const FFMPEG_COMPRESS_TIMEOUT_MS = 300000; // 5 min for compression

function esc(text: string): string {
  return escapeMarkdownV2(text);
}

async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function ensureUrl(token: string): string | null {
  if (token.startsWith('http://') || token.startsWith('https://')) return token;
  if (token.startsWith('www.')) return `https://${token}`;
  if (token.startsWith('reddit.com') || token.startsWith('old.reddit.com') || token.startsWith('new.reddit.com') || token.startsWith('m.reddit.com') || token.startsWith('redd.it') || token.startsWith('v.redd.it')) {
    return `https://${token}`;
  }
  if (/^[a-z0-9]{5,10}$/i.test(token)) {
    return `https://www.reddit.com/comments/${token}`;
  }
  return null;
}

function isRedditHost(hostname: string): boolean {
  return hostname === 'reddit.com' || hostname.endsWith('.reddit.com') || hostname === 'redd.it';
}

function extractVRedditIdFromUrl(url: URL): string | null {
  if (url.hostname !== 'v.redd.it') return null;
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  return parts[0] || null;
}

function dashUrlFromId(id: string): string {
  return `https://v.redd.it/${id}/DASHPlaylist.mpd`;
}

function normalizeHtml(html: string): string {
  return html
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

function extractVRedditIdFromHtml(html: string): string | null {
  const normalized = normalizeHtml(html);
  const match = normalized.match(/v\.redd\.it\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

function extractDashUrlFromHtml(html: string): string | null {
  const normalized = normalizeHtml(html);
  const match = normalized.match(/https?:\/\/v\.redd\.it\/[a-z0-9]+\/DASHPlaylist\.mpd/i);
  if (match) return match[0];
  const id = extractVRedditIdFromHtml(normalized);
  return id ? dashUrlFromId(id) : null;
}

async function resolveFinalUrl(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } }, PAGE_FETCH_TIMEOUT_MS);
  return response.url || url;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, PAGE_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Failed to fetch page (${response.status})`);
  }
  return await response.text();
}

async function parseDashManifest(dashUrl: string): Promise<{ videoUrl?: string; audioUrl?: string } | null> {
  try {
    const response = await fetchWithTimeout(dashUrl, { headers: { 'User-Agent': USER_AGENT } }, DASH_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`DASH fetch failed: ${response.status}`);
    }
    const xml = await response.text();

    let bestVideo: { bandwidth: number; url: string } | null = null;
    let bestAudio: { bandwidth: number; url: string } | null = null;

    const adaptationRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let adaptationMatch: RegExpExecArray | null;
    while ((adaptationMatch = adaptationRe.exec(xml)) !== null) {
      const attrs = adaptationMatch[1] || '';
      const body = adaptationMatch[2] || '';
      let contentType = '';

      const contentTypeMatch = attrs.match(/contentType="([^"]+)"/i);
      if (contentTypeMatch) {
        contentType = contentTypeMatch[1];
      } else {
        const mimeMatch = attrs.match(/mimeType="([^"]+)"/i);
        if (mimeMatch) contentType = mimeMatch[1];
      }

      const adaptationBase = extractBaseUrl(body);

      const repRe = /<Representation([^>]*)>([\s\S]*?)<\/Representation>/gi;
      let repMatch: RegExpExecArray | null;
      while ((repMatch = repRe.exec(body)) !== null) {
        const repAttrs = repMatch[1] || '';
        const repBody = repMatch[2] || '';
        const bandwidthMatch = repAttrs.match(/bandwidth="(\d+)"/i);
        const bandwidth = bandwidthMatch ? Number.parseInt(bandwidthMatch[1], 10) : 0;
        let repType = contentType;
        if (!repType) {
          const repMime = repAttrs.match(/mimeType="([^"]+)"/i);
          repType = repMime ? repMime[1] : '';
        }

        const repBase = extractBaseUrl(repBody) || adaptationBase;
        if (!repBase) continue;
        const resolved = resolveDashBaseUrl(dashUrl, repBase);

        if (/video/i.test(repType)) {
          if (!bestVideo || bandwidth > bestVideo.bandwidth) {
            bestVideo = { bandwidth, url: resolved };
          }
        } else if (/audio/i.test(repType)) {
          if (!bestAudio || bandwidth > bestAudio.bandwidth) {
            bestAudio = { bandwidth, url: resolved };
          }
        }
      }
    }

    return { videoUrl: bestVideo?.url, audioUrl: bestAudio?.url };
  } catch (error) {
    console.warn('[vReddit] Failed to parse DASH manifest:', error);
    return null;
  }
}

function extractBaseUrl(xml: string): string | null {
  const match = xml.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
  return match ? match[1].trim() : null;
}

function resolveDashBaseUrl(dashUrl: string, baseUrl: string): string {
  try {
    return new URL(baseUrl, dashUrl).toString();
  } catch {
    return `${dashUrl.replace(/\/[^/]*$/, '/')}${baseUrl}`;
  }
}

async function downloadFile(url: string, destPath: string, timeoutSec: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    execFile(
      'curl',
      [
        '-sS',
        '-f',
        '-L',
        '--connect-timeout', '10',
        '--max-time', String(timeoutSec),
        '--retry', '2',
        '--retry-delay', '2',
        '-o', destPath,
        url,
      ],
      { timeout: (timeoutSec + 10) * 1000 },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`Failed to download video: ${msg}`));
          return;
        }
        try {
          const stat = fs.statSync(destPath);
          resolve(stat.size);
        } catch (statError) {
          reject(statError instanceof Error ? statError : new Error('Failed to stat downloaded file'));
        }
      }
    );
  });
}

async function mergeVideoAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return await new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', '-movflags', '+faststart', outputPath],
      { timeout: FFMPEG_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`ffmpeg merge failed: ${msg}`));
          return;
        }
        resolve();
      }
    );
  });
}

async function getVideoDuration(filePath: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-i', filePath, '-show_entries', 'format=duration', '-v', 'quiet', '-of', 'csv=p=0'],
      { timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`ffprobe failed: ${msg}`));
          return;
        }
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration) || duration <= 0) {
          reject(new Error(`Invalid duration: ${stdout.trim()}`));
          return;
        }
        resolve(duration);
      }
    );
  });
}

async function compressCrf(inputPath: string, outputPath: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y', '-i', inputPath,
        '-c:v', 'libx264', '-crf', '28', '-preset', 'medium',
        '-vf', 'scale=-2:720',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
      ],
      { timeout: FFMPEG_COMPRESS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`ffmpeg CRF compress failed: ${msg}`));
          return;
        }
        try {
          const stat = fs.statSync(outputPath);
          resolve(stat.size);
        } catch (statError) {
          reject(statError instanceof Error ? statError : new Error('Failed to stat compressed file'));
        }
      }
    );
  });
}

async function compressTwoPass(
  inputPath: string,
  outputPath: string,
  targetSizeMB: number,
  durationSec: number
): Promise<number> {
  // Calculate target video bitrate in kbps: ((MB * 8192 kbits/MB) / seconds) - audio bitrate
  const videoBitrateKbps = Math.floor(((targetSizeMB * 8192) / durationSec) - 128);
  if (videoBitrateKbps <= 0) {
    throw new Error('Video too long to compress to target size');
  }

  const passLogFile = path.join(path.dirname(outputPath), 'ffmpeg2pass');

  // Pass 1
  await new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y', '-i', inputPath,
        '-c:v', 'libx264', '-b:v', `${videoBitrateKbps}k`,
        '-pass', '1', '-passlogfile', passLogFile,
        '-an', '-f', 'mp4',
        '/dev/null',
      ],
      { timeout: FFMPEG_COMPRESS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`ffmpeg two-pass (pass 1) failed: ${msg}`));
          return;
        }
        resolve();
      }
    );
  });

  // Pass 2
  return await new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y', '-i', inputPath,
        '-c:v', 'libx264', '-b:v', `${videoBitrateKbps}k`,
        '-pass', '2', '-passlogfile', passLogFile,
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath,
      ],
      { timeout: FFMPEG_COMPRESS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          const msg = (stderr || '').trim() || error.message;
          reject(new Error(`ffmpeg two-pass (pass 2) failed: ${msg}`));
          return;
        }
        try {
          const stat = fs.statSync(outputPath);
          resolve(stat.size);
        } catch (statError) {
          reject(statError instanceof Error ? statError : new Error('Failed to stat two-pass output'));
        }
      }
    );
  });
}

function getUrlExtension(urlString: string, fallback: string): string {
  try {
    const url = new URL(urlString);
    const ext = path.extname(url.pathname);
    return ext || fallback;
  } catch {
    return fallback;
  }
}

async function resolveDashUrlFromInput(input: string): Promise<string | null> {
  const token = normalizeInput(input);
  if (!token) return null;

  if (token.includes('DASHPlaylist.mpd')) {
    const url = ensureUrl(token);
    return url;
  }

  const candidateUrl = ensureUrl(token);
  if (!candidateUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return null;
  }

  if (parsed.hostname === 'v.redd.it') {
    const id = extractVRedditIdFromUrl(parsed);
    return id ? dashUrlFromId(id) : null;
  }

  if (!isRedditHost(parsed.hostname)) {
    return null;
  }

  const finalUrl = await resolveFinalUrl(parsed.toString());
  let finalParsed: URL;
  try {
    finalParsed = new URL(finalUrl);
  } catch {
    return null;
  }

  if (!isRedditHost(finalParsed.hostname)) {
    return null;
  }

  const html = await fetchHtml(finalParsed.toString());
  return extractDashUrlFromHtml(html);
}

export async function executeVReddit(ctx: Context, input: string): Promise<void> {
  const maxVideoBytes = config.REDDIT_VIDEO_MAX_SIZE_MB * 1024 * 1024;
  let tempDir: string | null = null;
  let ackMsg: { message_id: number } | null = null;

  try {
    ackMsg = await ctx.reply('🎬 Downloading Reddit video...', { parse_mode: undefined });

    const dashUrl = await resolveDashUrlFromInput(input);
    if (!dashUrl) {
      await replyMd(ctx, '❌ No Reddit\\-hosted video found in that link\\.');
      return;
    }

    const streams = await parseDashManifest(dashUrl);
    if (!streams?.videoUrl) {
      await replyMd(ctx, '❌ Failed to locate a downloadable video stream\\.');
      return;
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-vreddit-'));

    const videoExt = getUrlExtension(streams.videoUrl, '.mp4');
    const videoPath = path.join(tempDir, `video${videoExt}`);
    const videoSize = await downloadFile(streams.videoUrl, videoPath, VIDEO_DOWNLOAD_TIMEOUT_SEC);

    let finalPath = videoPath;
    let finalSize = videoSize;

    if (streams.audioUrl) {
      const audioExt = getUrlExtension(streams.audioUrl, '.mp4');
      const audioPath = path.join(tempDir, `audio${audioExt}`);
      await downloadFile(streams.audioUrl, audioPath, VIDEO_DOWNLOAD_TIMEOUT_SEC);

      const mergedPath = path.join(tempDir, 'video_merged.mp4');
      try {
        await mergeVideoAudio(videoPath, audioPath, mergedPath);
        const stat = fs.statSync(mergedPath);
        finalPath = mergedPath;
        finalSize = stat.size;
      } catch (error) {
        console.warn('[vReddit] Merge failed, sending video-only:', error);
      }
    }

    if (finalSize > maxVideoBytes) {
      // Save the original uncompressed video to the workspace directory
      const timestamp = Date.now();
      const savedDir = path.join(config.WORKSPACE_DIR, 'vreddit-originals');
      try {
        fs.mkdirSync(savedDir, { recursive: true });
        const savedPath = path.join(savedDir, `vreddit-${timestamp}.mp4`);
        fs.copyFileSync(finalPath, savedPath);
        console.log(`[vReddit] Saved original (${(finalSize / 1024 / 1024).toFixed(1)}MB) to ${savedPath}`);
      } catch (saveError) {
        console.warn('[vReddit] Failed to save original to workspace:', saveError);
      }

      // Stage 1: CRF-based compression (fast, good quality)
      if (ackMsg && ctx.chat?.id) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, ackMsg.message_id, '🎬 Compressing video...');
        } catch {
          // ignore edit errors
        }
      }

      console.log(`[vReddit] Video ${(finalSize / 1024 / 1024).toFixed(1)}MB exceeds limit, trying CRF compress`);
      const crfPath = path.join(tempDir!, 'video_crf.mp4');
      try {
        const crfSize = await compressCrf(finalPath, crfPath);
        console.log(`[vReddit] CRF compress: ${(crfSize / 1024 / 1024).toFixed(1)}MB`);

        if (crfSize <= maxVideoBytes) {
          finalPath = crfPath;
          finalSize = crfSize;
        } else {
          // Stage 2: Two-pass target compression (slower, exact size)
          console.log('[vReddit] CRF still too large, trying two-pass at 49MB target');
          const twoPassPath = path.join(tempDir!, 'video_2pass.mp4');
          const duration = await getVideoDuration(finalPath);
          const twoPassSize = await compressTwoPass(finalPath, twoPassPath, 49, duration);
          console.log(`[vReddit] Two-pass compress: ${(twoPassSize / 1024 / 1024).toFixed(1)}MB`);

          if (twoPassSize <= maxVideoBytes) {
            finalPath = twoPassPath;
            finalSize = twoPassSize;
          } else {
            await replyMd(ctx, '❌ Video is too large even after compression\\.');
            return;
          }
        }
      } catch (compressError) {
        console.warn('[vReddit] Compression failed:', compressError);
        await replyMd(ctx, '❌ Failed to compress video\\.');
        return;
      }
    }

    await ctx.replyWithChatAction('upload_video');
    await ctx.replyWithVideo(new InputFile(finalPath), {
      supports_streaming: true,
    });
  } catch (error) {
    console.warn('[vReddit] Failed to download video:', error);
    await replyMd(ctx, '❌ Failed to download Reddit video\\.');
  } finally {
    if (ackMsg && ctx.chat?.id) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ackMsg.message_id);
      } catch {
        // ignore delete errors
      }
    }
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('[vReddit] Cleanup failed:', cleanupError);
      }
    }
  }
}
