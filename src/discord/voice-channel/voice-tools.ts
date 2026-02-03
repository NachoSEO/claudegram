import { GoogleGenAI } from '@google/genai';
import { evaluate } from 'mathjs';
import { config } from '../../config.js';
import type { GeminiTool } from './gemini-live.js';

// Lazily-initialized GoogleGenAI client for tools that call the text API (e.g. deep_research).
let cachedTextAI: GoogleGenAI | null = null;
function getTextAI(): GoogleGenAI {
  if (!cachedTextAI) {
    if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
    cachedTextAI = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }
  return cachedTextAI;
}

const RESEARCH_TIMEOUT_MS = 30_000;

/**
 * Tools available to the Gemini Live voice agent.
 * Each tool can be invoked by voice — the user just describes what they want
 * and Gemini decides which tool to call.
 */

const getCurrentTime: GeminiTool = {
  name: 'get_current_time',
  description: 'Get the current date and time. Use when the user asks what time or date it is.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone (e.g. "America/New_York"). Defaults to server timezone if not provided.',
      },
    },
  },
  execute: async (args) => {
    const opts: Intl.DateTimeFormatOptions = {
      dateStyle: 'full',
      timeStyle: 'long',
    };
    if (args.timezone) {
      opts.timeZone = args.timezone;
    }
    return { datetime: new Date().toLocaleString('en-US', opts) };
  },
};

const rollDice: GeminiTool = {
  name: 'roll_dice',
  description: 'Roll one or more dice. Use when the user asks to roll dice or wants a random number.',
  parameters: {
    type: 'object',
    properties: {
      sides: {
        type: 'number',
        description: 'Number of sides on each die. Default 6.',
      },
      count: {
        type: 'number',
        description: 'Number of dice to roll. Default 1.',
      },
    },
  },
  execute: async (args) => {
    const sides = Math.max(2, Math.min(Math.floor(Number(args.sides) || 6), 1000));
    const count = Math.max(1, Math.min(Math.floor(Number(args.count) || 1), 100));
    const rolls = Array.from({ length: count }, () =>
      Math.floor(Math.random() * sides) + 1,
    );
    return { rolls, total: rolls.reduce((a: number, b: number) => a + b, 0) };
  },
};

const coinFlip: GeminiTool = {
  name: 'coin_flip',
  description: 'Flip a coin. Use when the user asks to flip a coin or needs a heads/tails decision.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async () => {
    return { result: Math.random() < 0.5 ? 'heads' : 'tails' };
  },
};

const doMath: GeminiTool = {
  name: 'calculate',
  description: 'Evaluate a math expression. Use for arithmetic, unit conversions, or any calculation the user asks about.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The math expression to evaluate (e.g. "2 + 2", "sqrt(144)", "15% of 200").',
      },
    },
    required: ['expression'],
  },
  execute: async (args) => {
    const expr = String(args.expression);
    try {
      // Preprocess natural language patterns before mathjs evaluation
      const prepared = expr
        .replace(/(\d+)%\s*of\s*(\d+)/gi, '($1/100)*$2')
        .replace(/\^/g, '^'); // mathjs uses ^ for power natively
      const result = evaluate(prepared);
      return { expression: expr, result: Number(result) };
    } catch {
      return { expression: expr, error: 'Could not evaluate expression' };
    }
  },
};

const translate: GeminiTool = {
  name: 'translate',
  description:
    'Translate text to another language. Returns structured data so you can speak the translation aloud in the target language with proper pronunciation.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to translate.',
      },
      from: {
        type: 'string',
        description: 'Source language (e.g. "English"). Can be "auto" for auto-detection.',
      },
      to: {
        type: 'string',
        description: 'Target language (e.g. "Spanish", "Japanese", "French").',
      },
    },
    required: ['text', 'to'],
  },
  execute: async (args) => {
    const text = String(args.text);
    const from = String(args.from || 'auto');
    const to = String(args.to);
    return {
      text,
      from,
      to,
      instruction: `Translate the following from ${from} to ${to}, then speak the translation aloud in ${to} with natural pronunciation: "${text}"`,
    };
  },
};

const deepResearch: GeminiTool = {
  name: 'deep_research',
  description:
    'Perform thorough research on a topic using Google Search. Use for questions that need up-to-date info, detailed answers, gaming strategies, news, or anything requiring web search. Runs in the background — the conversation can continue while research is happening.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The research question or topic to investigate.',
      },
    },
    required: ['query'],
  },
  behavior: 'NON_BLOCKING',
  execute: async (args) => {
    const query = String(args.query);
    if (!config.GEMINI_API_KEY) {
      return { error: 'GEMINI_API_KEY not configured for research.' };
    }

    try {
      const ai = getTextAI();
      const research = ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [{ text: `Research this topic thoroughly and provide a concise, informative summary:\n\n${query}` }],
          },
        ],
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Research timed out after 30s')), RESEARCH_TIMEOUT_MS),
      );

      const response = await Promise.race([research, timeout]);
      const text = response.text ?? '';
      const capped = text.length > 3000 ? text.slice(0, 3000) + '...' : text;
      return { query, result: capped };
    } catch (err: any) {
      console.error('[VoiceTools] deep_research failed:', err.message);
      return { query, error: `Research failed: ${err.message}` };
    }
  },
};

/** All voice tools — pass this array to createGeminiLiveSession. */
export const voiceTools: GeminiTool[] = [
  getCurrentTime,
  rollDice,
  coinFlip,
  doMath,
  translate,
  deepResearch,
];
