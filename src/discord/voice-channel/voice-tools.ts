import { evaluate } from 'mathjs';
import type { GeminiTool } from './gemini-live.js';

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

/** All voice tools — pass this array to createGeminiLiveSession. */
export const voiceTools: GeminiTool[] = [
  getCurrentTime,
  rollDice,
  coinFlip,
  doMath,
  translate,
];
