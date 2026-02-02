import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState,
  EndBehaviorType,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { createRequire } from 'node:module';
import { createPlaybackResampler, createReceiveResampler, type Resampler, type ReceiveResampler } from './audio-pipeline.js';
import { createGeminiLiveSession, type GeminiLiveSession } from './gemini-live.js';
import { voiceTools } from './voice-tools.js';

// prism-media is CJS-only — use createRequire for ESM compat
const require = createRequire(import.meta.url);
const prism = require('prism-media');

// Pre-warm @snazzah/davey so @discordjs/voice's internal daveLoadPromise
// resolves from the module cache before any voice connection is attempted.
// Without this, there's a race condition where the DAVE protocol check
// throws an uncaught exception because the async import hasn't resolved yet.
let daveyWarmed = false;
async function warmDavey(): Promise<void> {
  if (daveyWarmed) return;
  try {
    await import('@snazzah/davey');
    // Yield to let @discordjs/voice's internal daveLoadPromise microtask resolve
    await new Promise(resolve => setTimeout(resolve, 100));
    daveyWarmed = true;
    console.log('[Voice] DAVE protocol library pre-loaded');
  } catch (err) {
    console.warn('[Voice] Failed to pre-load @snazzah/davey:', err);
  }
}

// ── Per-guild voice session state ────────────────────────────────────

export interface VoiceSessionState {
  connection: VoiceConnection;
  player: AudioPlayer;
  gemini: GeminiLiveSession;
  playbackResampler: Resampler;
  receiveResamplers: Map<string, ReceiveResampler>;
  subscriptions: Map<string, AudioReceiveStream>;
  guildId: string;
  channelId: string;
  textChannelId?: string;
  onTextMessage?: (text: string) => void;
}

/** Mutable playback context shared across Gemini session reconnections. */
interface PlaybackCtx {
  resampler: Resampler;
  audioChunks: number;
}

const sessions = new Map<string, VoiceSessionState>();

// ── Gemini reconnect bookkeeping ─────────────────────────────────────

const MAX_RECONNECTS = 3;
const RECONNECT_DELAY_MS = 2000;
const reconnectAttempts = new Map<string, number>();

// ── Public API ───────────────────────────────────────────────────────

export function getVoiceSession(guildId: string): VoiceSessionState | undefined {
  return sessions.get(guildId);
}

export function isInVoiceChannel(guildId: string): boolean {
  return sessions.has(guildId);
}

/**
 * Join a Discord voice channel and establish a Gemini Live session.
 */
export async function joinAndConnect(
  channel: VoiceBasedChannel,
  opts?: {
    textChannelId?: string;
    onTextMessage?: (text: string) => void;
  },
): Promise<VoiceSessionState> {
  const guildId = channel.guild.id;

  // If already in this channel, return existing session
  const existing = sessions.get(guildId);
  if (existing && existing.channelId === channel.id && existing.gemini.isOpen) {
    return existing;
  }

  // If in a different channel, disconnect first
  if (existing) {
    await disconnect(guildId);
  }

  // 0) Pre-warm DAVE protocol library (prevents race condition crash)
  await warmDavey();

  // 1) Join Discord voice channel
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  connection.subscribe(player);

  // 2) Playback pipeline: Gemini PCM 24k mono → ffmpeg → Discord PCM 48k stereo
  const ctx: PlaybackCtx = {
    resampler: createPlaybackResampler(),
    audioChunks: 0,
  };
  let resource = createAudioResource(ctx.resampler.output, { inputType: StreamType.Raw });
  player.play(resource);

  // 3) Connect to Gemini Live
  const gemini = await connectGeminiSession(guildId, player, ctx);

  const state: VoiceSessionState = {
    connection,
    player,
    gemini,
    playbackResampler: ctx.resampler,
    receiveResamplers: new Map(),
    subscriptions: new Map(),
    guildId,
    channelId: channel.id,
    textChannelId: opts?.textChannelId,
    onTextMessage: opts?.onTextMessage,
  };

  sessions.set(guildId, state);
  reconnectAttempts.delete(guildId);

  // 4) Subscribe to incoming audio from voice channel users.
  //    We use Discord's speaking events to drive manual VAD (activityStart/End)
  //    so Gemini gets clean speech boundaries without its own VAD fighting us.
  //    activityEnd is debounced because Discord fires rapid end→start pairs for
  //    micro-pauses mid-sentence, which cause false barge-ins that kill responses.
  const speakingUsers = new Set<string>();
  let activityActive = false;
  let endDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const ACTIVITY_END_DEBOUNCE_MS = 300;

  connection.receiver.speaking.on('start', (userId) => {
    const currentState = sessions.get(guildId);
    if (!currentState || currentState !== state) return;
    subscribeToUser(currentState, userId);

    // Cancel any pending activityEnd — user resumed speaking
    if (endDebounceTimer) {
      clearTimeout(endDebounceTimer);
      endDebounceTimer = null;
    }

    speakingUsers.add(userId);
    if (!activityActive && currentState.gemini.isOpen) {
      console.log(`[Voice] activityStart (user ${userId} began speaking)`);
      currentState.gemini.sendActivityStart();
      activityActive = true;
    }
  });

  connection.receiver.speaking.on('end', (userId) => {
    const currentState = sessions.get(guildId);
    if (!currentState || currentState !== state) return;

    speakingUsers.delete(userId);

    // Debounce: wait before sending activityEnd so micro-pauses in speech
    // don't trigger false barge-ins while Gemini is responding.
    if (speakingUsers.size === 0 && activityActive) {
      if (endDebounceTimer) clearTimeout(endDebounceTimer);
      endDebounceTimer = setTimeout(() => {
        endDebounceTimer = null;
        if (speakingUsers.size === 0 && activityActive) {
          console.log(`[Voice] activityEnd (user ${userId} stopped speaking)`);
          if (currentState.gemini.isOpen) {
            currentState.gemini.sendActivityEnd();
          }
          activityActive = false;
        }
      }, ACTIVITY_END_DEBOUNCE_MS);
    }
  });

  // Handle disconnection — clean up immediately when the bot is kicked or
  // the connection drops, instead of trying to auto-recover (which caused
  // the bot to rejoin after being removed from the channel).
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    disconnect(guildId);
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    cleanupSession(guildId);
  });

  return state;
}

/**
 * Send a text prompt to Gemini Live (it responds with audio in the VC).
 */
export function sendTextToGemini(guildId: string, text: string): boolean {
  const state = sessions.get(guildId);
  if (!state || !state.gemini.isOpen) return false;
  state.gemini.sendText(text);
  return true;
}

/**
 * Disconnect from voice and close the Gemini session.
 */
export async function disconnect(guildId: string): Promise<void> {
  const state = sessions.get(guildId);
  if (!state) return;

  reconnectAttempts.delete(guildId);
  cleanupSession(guildId);

  try {
    state.connection.destroy();
  } catch { /* already destroyed */ }
}

// ── Gemini session factory (used for initial connect + reconnect) ────

async function connectGeminiSession(
  guildId: string,
  player: AudioPlayer,
  ctx: PlaybackCtx,
): Promise<GeminiLiveSession> {
  return createGeminiLiveSession({
    onAudio: (pcmBuffer) => {
      // If the player went Idle (stream drained between turns) or the
      // resampler ffmpeg died, reset the playback pipeline so new audio
      // actually reaches Discord.
      if (player.state.status === AudioPlayerStatus.Idle || !ctx.resampler.alive) {
        console.log(`[Voice] Playback pipeline stale (player=${player.state.status}, alive=${ctx.resampler.alive}) — resetting`);
        ctx.resampler.kill();
        ctx.audioChunks = 0;
        ctx.resampler = createPlaybackResampler();
        const res = createAudioResource(ctx.resampler.output, { inputType: StreamType.Raw });
        player.play(res);
        const st = sessions.get(guildId);
        if (st) st.playbackResampler = ctx.resampler;
      }

      ctx.audioChunks++;
      if (ctx.audioChunks === 1 || ctx.audioChunks % 50 === 0) {
        console.log(`[Voice] Audio chunk #${ctx.audioChunks} (${pcmBuffer.length} bytes) → resampler`);
      }
      // Write without backpressure handling — for real-time audio we
      // prioritise latency.  The old `.once('drain')` pattern leaked
      // listeners (MaxListenersExceededWarning).
      ctx.resampler.input.write(pcmBuffer);
    },

    onInterrupted: () => {
      console.log('[Voice] Barge-in — resetting playback pipeline');
      ctx.resampler.kill();
      ctx.audioChunks = 0;
      ctx.resampler = createPlaybackResampler();
      const res = createAudioResource(ctx.resampler.output, { inputType: StreamType.Raw });
      player.play(res);
      const st = sessions.get(guildId);
      if (st) st.playbackResampler = ctx.resampler;
    },

    onTurnComplete: () => {
      console.log(`[Voice] Gemini turn complete (${ctx.audioChunks} audio chunks played)`);
      ctx.audioChunks = 0;
    },

    onOpen: () => {
      console.log(`[Voice] Gemini Live connected (guild ${guildId})`);
      // Delay clearing the reconnect counter — if the session closes within
      // seconds of opening (unstable), the counter keeps incrementing so we
      // eventually hit MAX_RECONNECTS and stop instead of looping forever.
      setTimeout(() => {
        if (sessions.has(guildId)) {
          reconnectAttempts.delete(guildId);
        }
      }, 30_000);
    },

    onError: (err) => {
      console.error(`[Voice] Gemini Live error (guild ${guildId}):`, err.message);
    },

    onClose: (reason) => {
      console.log(`[Voice] Gemini Live closed (guild ${guildId}): ${reason}`);
      // Auto-reconnect if the session still exists (user didn't /voice leave)
      attemptGeminiReconnect(guildId, player, ctx);
    },

    onText: (text) => {
      const st = sessions.get(guildId);
      st?.onTextMessage?.(text);
    },
  }, voiceTools);
}

// ── Gemini auto-reconnect ────────────────────────────────────────────

async function attemptGeminiReconnect(
  guildId: string,
  player: AudioPlayer,
  ctx: PlaybackCtx,
): Promise<void> {
  const state = sessions.get(guildId);
  if (!state) return; // session fully torn down — user /voice leave'd

  const attempts = (reconnectAttempts.get(guildId) ?? 0) + 1;
  if (attempts > MAX_RECONNECTS) {
    console.error(`[Voice] Max Gemini reconnects (${MAX_RECONNECTS}) reached — giving up`);
    state.onTextMessage?.('⚠️ Gemini session lost after multiple retries. Use `/voice leave` then `/voice join` to reconnect.');
    reconnectAttempts.delete(guildId);
    return;
  }

  reconnectAttempts.set(guildId, attempts);
  const delay = RECONNECT_DELAY_MS * attempts; // linear backoff
  console.log(`[Voice] Reconnecting Gemini (attempt ${attempts}/${MAX_RECONNECTS}) in ${delay}ms…`);

  await new Promise(resolve => setTimeout(resolve, delay));

  // Re-check — user might have /voice leave'd during the delay
  if (!sessions.has(guildId)) {
    reconnectAttempts.delete(guildId);
    return;
  }

  try {
    // Reset playback pipeline for a clean slate
    ctx.resampler.kill();
    ctx.audioChunks = 0;
    ctx.resampler = createPlaybackResampler();
    const res = createAudioResource(ctx.resampler.output, { inputType: StreamType.Raw });
    player.play(res);
    state.playbackResampler = ctx.resampler;

    const newGemini = await connectGeminiSession(guildId, player, ctx);

    // Re-check after the async connect — the user might have /voice leave'd
    // while we were connecting, which would leave an orphan Gemini session.
    if (!sessions.has(guildId)) {
      newGemini.close();
      return;
    }

    state.gemini = newGemini;
  } catch (err: any) {
    console.error(`[Voice] Gemini reconnect attempt ${attempts} failed:`, err.message);
    // The new session's onClose will trigger another attempt if under the limit
  }
}

// ── User receive subscription ────────────────────────────────────────

function subscribeToUser(state: VoiceSessionState, userId: string): void {
  // If the existing opus subscription is still healthy, nothing to do
  const existing = state.subscriptions.get(userId);
  if (existing && !existing.destroyed && existing.readable) return;

  // Clean up dead opus stream (but keep the resampler alive — it's persistent)
  if (existing) {
    state.subscriptions.delete(userId);
    try { existing.destroy(); } catch { /* ignore */ }
  }

  console.log(`[Voice] Subscribing to user audio: ${userId}`);

  const opusStream = state.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  state.subscriptions.set(userId, opusStream);

  // Opus → PCM 48k stereo via prism-media decoder (new each subscription cycle)
  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  // Get or create a persistent receive resampler for this user.
  // The resampler (ffmpeg process) survives opus stream death so we
  // don't spawn a new ffmpeg every time Discord re-subscribes.
  let recvResampler = state.receiveResamplers.get(userId);
  if (!recvResampler || !recvResampler.alive) {
    if (recvResampler) recvResampler.kill();
    recvResampler = createReceiveResampler();
    state.receiveResamplers.set(userId, recvResampler);

    // Attach the data handler once per resampler lifetime
    let userChunks = 0;
    recvResampler.output.on('data', (chunk: Buffer) => {
      if (state.gemini.isOpen) {
        userChunks++;
        if (userChunks === 1 || userChunks % 100 === 0) {
          console.log(`[Voice] User ${userId} audio chunk #${userChunks} (${chunk.length} bytes) → Gemini`);
        }
        state.gemini.sendAudio(chunk);
      }
    });
  }

  // Pipe opus→decoder normally (decoder dies with the stream — that's fine).
  // Use { end: false } on decoder→resampler so the ffmpeg resampler survives.
  opusStream.pipe(decoder);
  decoder.pipe(recvResampler.input, { end: false });

  // When the opus stream dies, just remove the subscription entry.
  // The resampler stays alive for the next subscription cycle.
  const onStreamDeath = () => {
    state.subscriptions.delete(userId);
    try { decoder.destroy(); } catch { /* ignore */ }
  };
  opusStream.on('close', onStreamDeath);
  opusStream.on('error', (err: Error) => {
    console.error(`[Voice] Opus stream error for ${userId}:`, err.message);
    onStreamDeath();
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────

function cleanupSession(guildId: string): void {
  const state = sessions.get(guildId);
  if (!state) return;

  // Remove from the map FIRST — if gemini.close() triggers an onClose
  // callback synchronously, attemptGeminiReconnect will check the map
  // and bail out because the session is already gone.
  sessions.delete(guildId);

  state.gemini.close();
  state.playbackResampler.kill();

  for (const [, resampler] of state.receiveResamplers) {
    resampler.kill();
  }
  state.receiveResamplers.clear();

  for (const [, stream] of state.subscriptions) {
    try { stream.destroy(); } catch { /* ignore */ }
  }
  state.subscriptions.clear();

  state.player.stop(true);
  console.log(`[Voice] Cleaned up session for guild ${guildId}`);
}
