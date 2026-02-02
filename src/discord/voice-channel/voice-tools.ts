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
    const sides = args.sides ?? 6;
    const count = args.count ?? 1;
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
    // Simple safe math evaluation — only allows numbers, operators, parens, and Math functions
    const expr = String(args.expression);
    const sanitized = expr.replace(/[^0-9+\-*/().,%^ sqrtabceilflooroundlogpowmin max PI E]/g, '');
    try {
      // Replace common patterns before eval
      const prepared = sanitized
        .replace(/(\d+)%\s*of\s*(\d+)/gi, '($1/100)*$2')
        .replace(/sqrt/g, 'Math.sqrt')
        .replace(/abs/g, 'Math.abs')
        .replace(/ceil/g, 'Math.ceil')
        .replace(/floor/g, 'Math.floor')
        .replace(/round/g, 'Math.round')
        .replace(/log/g, 'Math.log')
        .replace(/pow/g, 'Math.pow')
        .replace(/min/g, 'Math.min')
        .replace(/max/g, 'Math.max')
        .replace(/PI/g, 'Math.PI')
        .replace(/\^/g, '**');
      // eslint-disable-next-line no-eval
      const result = Function(`"use strict"; return (${prepared})`)();
      return { expression: expr, result: Number(result) };
    } catch {
      return { expression: expr, error: 'Could not evaluate expression' };
    }
  },
};

/** All voice tools — pass this array to createGeminiLiveSession. */
export const voiceTools: GeminiTool[] = [
  getCurrentTime,
  rollDice,
  coinFlip,
  doMath,
];
