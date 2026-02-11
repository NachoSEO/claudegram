import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai';
import type { Client } from 'discord.js';
import { config } from '../../config.js';
import { eventBus } from '../../dashboard/event-bus.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GeminiLiveCallbacks {
  /** Called with raw PCM audio chunks (24kHz mono s16le, base64-decoded). */
  onAudio: (pcmBuffer: Buffer) => void;
  /** Called when Gemini signals an interruption (barge-in). */
  onInterrupted: () => void;
  /** Called when the model's turn is complete. */
  onTurnComplete: () => void;
  /** Called when the session opens. */
  onOpen: () => void;
  /** Called on error. */
  onError: (error: Error) => void;
  /** Called when the session closes. */
  onClose: (reason: string) => void;
  /** Called with text transcription of model output (if available). */
  onText?: (text: string) => void;
}

export interface GeminiLiveSession {
  /** Send a text prompt to the model (it responds with audio). */
  sendText: (text: string) => void;
  /** Send raw PCM audio (16kHz mono s16le) from the user's mic. */
  sendAudio: (pcm16kBuffer: Buffer) => void;
  /** Signal that a user started speaking (manual VAD). Optionally include speaker name. */
  sendActivityStart: (speakerName?: string) => void;
  /** Signal that a user stopped speaking (manual VAD). */
  sendActivityEnd: () => void;
  /** Close the session. */
  close: () => void;
  /** Whether the session is currently open. */
  isOpen: boolean;
}

/** A tool that Gemini can call via function calling. */
export interface GeminiTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters (type: "object"). */
  parameters: Record<string, any>;
  /** Execute the tool and return a result (sent back to Gemini). */
  execute: (args: Record<string, any>) => Promise<any>;
  /** Tool execution behavior: BLOCKING pauses audio, NON_BLOCKING lets conversation continue. */
  behavior?: 'BLOCKING' | 'NON_BLOCKING';
}

/** Context passed to Discord-aware voice tools so they can interact with the server. */
export interface VoiceToolContext {
  client: Client;
  guildId: string;
  channelId: string;
  textChannelId?: string;
}

// ── Constants ────────────────────────────────────────────────────────

const MODEL = 'gemini-2.5-flash-native-audio-latest';

const SYSTEM_INSTRUCTION = `You are BigBroDoe, a helpful and chill voice assistant hanging out in a Discord voice channel.
Keep responses concise and conversational — you're speaking out loud, not writing an essay.
If someone asks a factual question, use Google Search to find accurate answers.

You have access to tools — use them when relevant:
- Time, dice, math, coin flips for quick queries
- read_chat to see what's happening in the text channel
- send_message to post messages to the text channel
- kick_from_voice to remove someone from the voice channel (only when asked)
- translate to help with translations — you can speak the translated text aloud in the target language
- deep_research for thorough research on any topic (runs in the background)
- search_memory to recall things from your knowledge base — use when the user asks about something they previously mentioned or stored
- remember to save important info for later — use when the user asks you to remember something or when key context should be preserved
- ask_claude to delegate complex tasks to Claude (deep reasoning, code gen, analysis) — runs in the background, summarize the result when it comes back
- ask_droid for lightning-fast code generation and quick tasks via Groq LPU — runs in the background
- run_command to execute shell commands on the Linux desktop (system info, file ops, scripts)

When you use a tool, tell the user the result naturally in speech.
Be natural, use casual language, and match the energy of the conversation.
You can sense tone and emotion — adapt your responses accordingly.
In group conversations, only speak when addressed or when you have something genuinely useful to add.`;

// ── Session factory ──────────────────────────────────────────────────

export async function createGeminiLiveSession(
  callbacks: GeminiLiveCallbacks,
  tools: GeminiTool[] = [],
  guildId?: string,
): Promise<GeminiLiveSession> {
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured.');
  }

  const ai = new GoogleGenAI({
    apiKey: config.GEMINI_API_KEY,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  // Build a lookup map and Gemini function declarations from tools
  const toolMap = new Map<string, GeminiTool>();
  const functionDeclarations: any[] = [];
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
    const decl: any = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
    if (tool.behavior) decl.behavior = tool.behavior;
    functionDeclarations.push(decl);
  }

  const configTools: any[] = [{ googleSearch: {} }];
  if (functionDeclarations.length > 0) {
    configTools.push({ functionDeclarations });
  }

  let isOpen = false;

  const session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: configTools,
      enableAffectiveDialog: true,
      proactivity: { proactiveAudio: true },
      // Disable Gemini's built-in VAD — we drive activity detection from
      // Discord's speaking events (activityStart / activityEnd) so the
      // model gets clean, precise speech boundaries instead of trying to
      // do its own VAD on choppy, resampled audio.
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: true,
        },
      },
      // Disable thinking for lowest-latency voice responses.
      thinkingConfig: { thinkingBudget: 0 },
    } as any, // cast: realtimeInputConfig / thinkingConfig may not be in SDK types yet
    callbacks: {
      onopen: () => {
        isOpen = true;
        callbacks.onOpen();
      },
      onerror: (e: any) => {
        console.error('[GeminiLive] Error event:', e?.message || e);
        callbacks.onError(new Error(e?.message || 'Gemini Live error'));
      },
      onclose: (e: any) => {
        isOpen = false;
        const code = e?.code ?? 'unknown';
        const reason = e?.reason || 'no reason';
        console.log(`[GeminiLive] Close event — code=${code}, reason=${reason}`);
        callbacks.onClose(`code=${code}: ${reason}`);
      },
      onmessage: (msg: LiveServerMessage) => {
        // Setup complete signal
        if ((msg as any).setupComplete) {
          console.log('[GeminiLive] Setup complete');
          return;
        }

        // Handle interruptions (barge-in)
        if (msg.serverContent?.interrupted) {
          console.log('[GeminiLive] Interrupted (barge-in)');
          callbacks.onInterrupted();
          return;
        }

        // Handle turn completion
        if (msg.serverContent?.turnComplete) {
          callbacks.onTurnComplete();
          return;
        }

        // Handle tool calls (function calling)
        if ((msg as any).toolCall) {
          handleToolCall(session, (msg as any).toolCall, toolMap, guildId).catch(err => {
            console.error('[GeminiLive] Tool call execution error:', err);
          });
          return;
        }

        // Process model turn parts
        const parts = msg.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          // Audio data
          const b64 = part.inlineData?.data;
          if (typeof b64 === 'string' && b64.length > 0) {
            const pcmBuffer = Buffer.from(b64, 'base64');
            callbacks.onAudio(pcmBuffer);
          }

          // Text (transcription or text response)
          if (part.text) {
            callbacks.onText?.(part.text);
          }
        }
      },
    },
  });

  const liveSession: GeminiLiveSession = {
    sendText: (text: string) => {
      if (!isOpen) return;
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
      });
    },

    sendAudio: (pcm16kBuffer: Buffer) => {
      if (!isOpen) return;
      session.sendRealtimeInput({
        audio: {
          data: pcm16kBuffer.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    },

    sendActivityStart: (speakerName?: string) => {
      if (!isOpen) return;
      // If we know who's speaking, tell Gemini before sending activityStart.
      // NOTE: There's an inherent race between sendClientContent and
      // sendRealtimeInput — the speaker hint may arrive after audio starts.
      // This is a known limitation; Gemini handles it gracefully in practice.
      if (speakerName) {
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `[${speakerName} is now speaking]` }] }],
          turnComplete: false,
        });
      }
      (session as any).sendRealtimeInput({ activityStart: {} });
    },

    sendActivityEnd: () => {
      if (!isOpen) return;
      (session as any).sendRealtimeInput({ activityEnd: {} });
    },

    close: () => {
      isOpen = false;
      try { session.close(); } catch { /* already closed */ }
    },

    get isOpen() { return isOpen; },
  };

  return liveSession;
}

// ── Tool call handler ────────────────────────────────────────────────

async function handleToolCall(
  session: any,
  toolCall: any,
  toolMap: Map<string, GeminiTool>,
  guildId?: string,
): Promise<void> {
  const functionResponses: any[] = [];

  for (const fc of toolCall.functionCalls ?? []) {
    console.log(`[GeminiLive] Tool call: ${fc.name}(${JSON.stringify(fc.args)})`);
    eventBus.emit('voice:tool_call', { guildId: guildId ?? 'unknown', toolName: fc.name, args: fc.args ?? {}, timestamp: Date.now() });

    const tool = toolMap.get(fc.name);
    if (tool) {
      try {
        const result = await tool.execute(fc.args ?? {});
        functionResponses.push({
          id: fc.id,
          name: fc.name,
          response: { result: typeof result === 'string' ? result : JSON.stringify(result) },
        });
        console.log(`[GeminiLive] Tool ${fc.name} returned:`, result);
      } catch (err: any) {
        console.error(`[GeminiLive] Tool ${fc.name} failed:`, err.message);
        functionResponses.push({
          id: fc.id,
          name: fc.name,
          response: { error: err.message },
        });
      }
    } else {
      // Provider-handled tools (e.g. googleSearch) are executed server-side
      // by Gemini and should not receive a client-side function response.
      // Only respond for genuinely unknown tools.
      const providerTools = ['googleSearch', 'google_search'];
      if (!providerTools.includes(fc.name)) {
        console.warn(`[GeminiLive] Unknown tool called: ${fc.name}`);
        functionResponses.push({
          id: fc.id,
          name: fc.name,
          response: { error: `Unknown tool: '${fc.name}'` },
        });
      }
    }
  }

  if (functionResponses.length > 0) {
    try {
      session.sendToolResponse({ functionResponses });
    } catch (err: any) {
      console.error('[GeminiLive] Failed to send tool response:', err.message);
    }
  }
}
