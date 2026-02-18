import { Context, InputFile } from 'grammy';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config.js';
import { isUrlAllowed } from '../utils/url-guard.js';

const USER_AGENT = 'claudegram/1.0';
const DASH_FETCH_TIMEOUT_MS = 15000;
const VIDEO_DOWNLOAD_TIMEOUT_SEC = 120;
const FFMPEG_TIMEOUT_MS = 120000;
const FFMPEG_COMPRESS_TIMEOUT_MS = 300000; // 5 min for compression

/** Conditional debug logging - only logs when LOG_AGENT_HOOKS is enabled */
function debugLog(message: string): void {
  if (config.LOG_AGENT_HOOKS) {
    console.log(message);
  }
}

type VideoSource =
  | { type: 'dash'; url: string }
  | { type: 'external'; url: string }
  | null;

/**
 * Validate URL protocol to prevent SSRF attacks.
 * Only allows http/https protocols.
 */
function isValidProtocol(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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
  let url: string | null = null;

  if (token.startsWith('http://') || token.startsWith('https://')) {
    url = token;
  } else if (token.startsWith('www.')) {
    url = `https://${token}`;
  } else if (token.startsWith('reddit.com') || token.startsWith('old.reddit.com') || token.startsWith('new.reddit.com') || token.startsWith('m.reddit.com') || token.startsWith('redd.it') || token.startsWith('v.redd.it')) {
    url = `https://${token}`;
  } else if (/^[a-z0-9]{5,10}$/i.test(token)) {
    url = `https://www.reddit.com/comments/${token}`;
  }

  // Validate protocol to prevent SSRF
  if (url && !isValidProtocol(url)) {
    return null;
  }

  return url;
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

function extractExternalUrlFromHtml(html: string): string | null {
  const match = html.match(/data-url="(https?:\/\/[^"]+)"/);
  if (!match) return null;
  const url = match[1];
  // Skip Reddit self-links and images
  if (url.includes('reddit.com') || url.includes('redd.it')) return null;
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) return null;
  // Validate protocol to prevent SSRF
  if (!isValidProtocol(url)) return null;
  return url;
}

async function resolveFinalUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sS', '-L', '-o', '/dev/null', '-w', '%{url_effective}',
       '-H', `User-Agent: ${USER_AGENT}`,
       '--connect-timeout', '15', '--max-time', '30',
       url],
      { timeout: 35000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to resolve URL: ${(stderr || '').trim() || error.message}`));
          return;
        }
        resolve(stdout.trim() || url);
      }
    );
  });
}

async function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sS', '-L', '-f',
       '-H', `User-Agent: ${USER_AGENT}`,
       '-b', 'over18=1',
       '--connect-timeout', '15', '--max-time', '30',
       url],
      { timeout: 35000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to fetch page: ${(stderr || '').trim() || error.message}`));
          return;
        }
        if (!stdout) {
          reject(new Error('Empty response from page'));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// Limits to prevent ReDoS and resource exhaustion
const MAX_DASH_XML_SIZE = 512 * 1024; // 512KB max manifest size
const MAX_ADAPTATION_SETS = 20;
const MAX_REPRESENTATIONS = 50;

async function parseDashManifest(dashUrl: string): Promise<{ videoUrl?: string; audioUrl?: string } | null> {
  try {
    const response = await fetchWithTimeout(dashUrl, { headers: { 'User-Agent': USER_AGENT } }, DASH_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`DASH fetch failed: ${response.status}`);
    }
    const xml = await response.text();

    // Prevent ReDoS by limiting input size
    if (xml.length > MAX_DASH_XML_SIZE) {
      console.warn(`[vReddit] DASH manifest too large (${xml.length} bytes), skipping`);
      return null;
    }

    let bestVideo: { bandwidth: number; url: string } | null = null;
    let bestAudio: { bandwidth: number; url: string } | null = null;

    const adaptationRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let adaptationMatch: RegExpExecArray | null;
    let adaptationCount = 0;
    let totalRepCount = 0;

    while ((adaptationMatch = adaptationRe.exec(xml)) !== null) {
      // Limit iterations to prevent DoS
      if (++adaptationCount > MAX_ADAPTATION_SETS) {
        console.warn('[vReddit] Too many AdaptationSets, stopping parse');
        break;
      }

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
        // Limit total representations across all adaptation sets
        if (++totalRepCount > MAX_REPRESENTATIONS) {
          console.warn('[vReddit] Too many Representations, stopping parse');
          break;
        }

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

      if (totalRepCount > MAX_REPRESENTATIONS) break;
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

async function downloadWithYtDlp(url: string, outputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      [
        '-f', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
        '--no-playlist',
        '--socket-timeout', '30',
        '--', url,
      ],
      { timeout: VIDEO_DOWNLOAD_TIMEOUT_SEC * 1000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`yt-dlp failed: ${(stderr || '').trim() || error.message}`));
          return;
        }
        try {
          const stat = fs.statSync(outputPath);
          resolve(stat.size);
        } catch (e) {
          reject(e instanceof Error ? e : new Error('Failed to stat yt-dlp output'));
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

async function resolveVideoSource(input: string): Promise<VideoSource> {
  const token = normalizeInput(input);
  debugLog(`[vReddit] Input: "${input}" → token: "${token}"`);
  if (!token) return null;

  if (token.includes('DASHPlaylist.mpd')) {
    const url = ensureUrl(token);
    debugLog(`[vReddit] Direct DASH URL: ${url}`);
    if (url && !(await isUrlAllowed(url))) {
      debugLog('[vReddit] Blocked DASH URL (private network)');
      return null;
    }
    return url ? { type: 'dash', url } : null;
  }

  const candidateUrl = ensureUrl(token);
  debugLog(`[vReddit] Candidate URL: ${candidateUrl}`);
  if (!candidateUrl) return null;
  if (!(await isUrlAllowed(candidateUrl))) {
    debugLog('[vReddit] Blocked URL (private network)');
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    debugLog('[vReddit] Failed to parse URL');
    return null;
  }

  if (parsed.hostname === 'v.redd.it') {
    const id = extractVRedditIdFromUrl(parsed);
    debugLog(`[vReddit] v.redd.it ID: ${id}`);
    return id ? { type: 'dash', url: dashUrlFromId(id) } : null;
  }

  if (!isRedditHost(parsed.hostname)) {
    debugLog(`[vReddit] Not a Reddit host: ${parsed.hostname}`);
    return null;
  }

  debugLog(`[vReddit] Resolving final URL from: ${parsed.toString()}`);
  const finalUrl = await resolveFinalUrl(parsed.toString());
  debugLog(`[vReddit] Final URL: ${finalUrl}`);
  if (!(await isUrlAllowed(finalUrl))) {
    debugLog('[vReddit] Blocked final URL (private network)');
    return null;
  }

  let finalParsed: URL;
  try {
    finalParsed = new URL(finalUrl);
  } catch {
    debugLog('[vReddit] Failed to parse final URL');
    return null;
  }

  if (!isRedditHost(finalParsed.hostname)) {
    debugLog(`[vReddit] Final URL not Reddit host: ${finalParsed.hostname}`);
    return null;
  }

  // Rewrite to old.reddit.com for HTML fetch — old.reddit.com serves simpler HTML
  // with v.redd.it references and respects the over18=1 cookie for NSFW content
  if (['www.reddit.com', 'new.reddit.com', 'm.reddit.com', 'reddit.com'].includes(finalParsed.hostname)) {
    finalParsed.hostname = 'old.reddit.com';
  }

  debugLog(`[vReddit] Fetching HTML from: ${finalParsed.toString()}`);
  const html = await fetchHtml(finalParsed.toString());
  debugLog(`[vReddit] HTML length: ${html.length} chars`);

  const dashUrl = extractDashUrlFromHtml(html);
  if (dashUrl) {
    debugLog(`[vReddit] Extracted DASH URL: ${dashUrl}`);
    if (!(await isUrlAllowed(dashUrl))) {
      debugLog('[vReddit] Blocked DASH URL (private network)');
      return null;
    }
    return { type: 'dash', url: dashUrl };
  }

  // Fallback: check for external video embed (e.g. redgifs.com)
  const externalUrl = extractExternalUrlFromHtml(html);
  if (externalUrl) {
    debugLog(`[vReddit] Found external video embed: ${externalUrl}`);
    if (!(await isUrlAllowed(externalUrl))) {
      debugLog('[vReddit] Blocked external URL (private network)');
      return null;
    }
    return { type: 'external', url: externalUrl };
  }

  debugLog('[vReddit] No video source found in HTML');
  return null;
}

export async function executeVReddit(ctx: Context, input: string): Promise<void> {
  const maxVideoBytes = config.REDDIT_VIDEO_MAX_SIZE_MB * 1024 * 1024;
  let tempDir: string | null = null;
  let ackMsg: { message_id: number } | null = null;

  try {
    ackMsg = await ctx.reply('🎬 Downloading Reddit video...', { parse_mode: undefined });

    const source = await resolveVideoSource(input);
    if (!source) {
      await replyMd(ctx, '❌ No video found in that link\\.');
      return;
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-vreddit-'));

    let finalPath: string;
    let finalSize: number;

    if (source.type === 'dash') {
      // === DASH pipeline (Reddit-hosted video) ===
      debugLog(`[vReddit] Parsing DASH manifest: ${source.url}`);
      const streams = await parseDashManifest(source.url);
      if (!streams?.videoUrl) {
        debugLog('[vReddit] No video stream found in DASH manifest');
        await replyMd(ctx, '❌ Failed to locate a downloadable video stream\\.');
        return;
      }
      debugLog(`[vReddit] Video stream: ${streams.videoUrl}`);
      if (streams.audioUrl) debugLog(`[vReddit] Audio stream: ${streams.audioUrl}`);

      // Validate DASH-derived stream URLs against private networks (SSRF protection)
      if (!(await isUrlAllowed(streams.videoUrl))) {
        debugLog('[vReddit] Blocked video stream URL (private network)');
        await replyMd(ctx, '❌ Video stream URL blocked for security reasons\\.');
        return;
      }

      const videoExt = getUrlExtension(streams.videoUrl, '.mp4');
      const videoPath = path.join(tempDir, `video${videoExt}`);
      debugLog('[vReddit] Downloading video stream...');
      const videoSize = await downloadFile(streams.videoUrl, videoPath, VIDEO_DOWNLOAD_TIMEOUT_SEC);
      debugLog(`[vReddit] Video downloaded: ${(videoSize / 1024 / 1024).toFixed(1)}MB`);

      finalPath = videoPath;
      finalSize = videoSize;

      if (streams.audioUrl) {
        if (!(await isUrlAllowed(streams.audioUrl))) {
          debugLog('[vReddit] Blocked audio stream URL (private network), sending video-only');
        } else {
          const audioExt = getUrlExtension(streams.audioUrl, '.mp4');
          const audioPath = path.join(tempDir, `audio${audioExt}`);
          debugLog('[vReddit] Downloading audio stream...');
          await downloadFile(streams.audioUrl, audioPath, VIDEO_DOWNLOAD_TIMEOUT_SEC);

          const mergedPath = path.join(tempDir, 'video_merged.mp4');
          try {
            console.log('[vReddit] Merging video + audio...');
            await mergeVideoAudio(videoPath, audioPath, mergedPath);
            const stat = fs.statSync(mergedPath);
            finalPath = mergedPath;
            finalSize = stat.size;
            console.log(`[vReddit] Merged: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
          } catch (error) {
            console.warn('[vReddit] Merge failed, sending video-only:', error);
          }
        }
      }
    } else {
      // === External embed pipeline (yt-dlp) ===
      let domain: string;
      try {
        domain = new URL(source.url).hostname;
      } catch {
        domain = 'external site';
      }
      console.log(`[vReddit] Downloading external video via yt-dlp: ${source.url}`);
      if (ackMsg && ctx.chat?.id) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, ackMsg.message_id, `🎬 Downloading video from ${domain}...`);
        } catch {
          // ignore edit errors
        }
      }

      const ytdlpPath = path.join(tempDir, 'video_ytdlp.mp4');
      finalSize = await downloadWithYtDlp(source.url, ytdlpPath);
      finalPath = ytdlpPath;
      console.log(`[vReddit] yt-dlp downloaded: ${(finalSize / 1024 / 1024).toFixed(1)}MB`);
    }

    if (finalSize > maxVideoBytes) {
      // Save the original uncompressed video to a temp directory for later retrieval
      // Uses OS temp directory rather than hardcoded paths
      const timestamp = Date.now();
      const savedDir = path.join(os.tmpdir(), 'claudegram-vreddit-originals');
      try {
        fs.mkdirSync(savedDir, { recursive: true, mode: 0o700 });
        const savedPath = path.join(savedDir, `vreddit-${timestamp}.mp4`);
        fs.copyFileSync(finalPath, savedPath);
        console.log(`[vReddit] Saved original (${(finalSize / 1024 / 1024).toFixed(1)}MB) to ${savedPath}`);
      } catch (saveError) {
        console.warn('[vReddit] Failed to save original to temp:', saveError);
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
      const crfPath = path.join(tempDir, 'video_crf.mp4');
      try {
        const crfSize = await compressCrf(finalPath, crfPath);
        console.log(`[vReddit] CRF compress: ${(crfSize / 1024 / 1024).toFixed(1)}MB`);

        if (crfSize <= maxVideoBytes) {
          finalPath = crfPath;
          finalSize = crfSize;
        } else {
          // Stage 2: Two-pass target compression (slower, exact size)
          console.log('[vReddit] CRF still too large, trying two-pass at 49MB target');
          const twoPassPath = path.join(tempDir, 'video_2pass.mp4');
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

    console.log(`[vReddit] Uploading ${(finalSize / 1024 / 1024).toFixed(1)}MB video to Telegram...`);
    await ctx.replyWithChatAction('upload_video');
    await ctx.replyWithVideo(new InputFile(finalPath), {
      supports_streaming: true,
    });
  } catch (error) {
    console.warn('[vReddit] Failed to download video:', error);
    await replyMd(ctx, '❌ Failed to download video\\.');
  } finally {
    if (ackMsg && ctx.chat?.id) {
      try {
        await ctx.api.deleteMessage(ctx.chat.id, ackMsg.message_id);
      } catch (e) {
        console.debug('[vReddit] Failed to delete ack message:', e instanceof Error ? e.message : e);
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
