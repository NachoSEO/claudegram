/**
 * Custom fsuite tools for the OpenAI Agents SDK.
 *
 * Wraps the native fsuite CLI tools (ftree, fsearch, fcontent, fmap, fmetrics)
 * as Agent SDK `tool()` definitions so the model can explore the filesystem.
 */

import { execFile } from 'node:child_process';
import { tool } from '@openai/agents';
import { z } from 'zod';

import { resolveBin } from '../utils/resolve-bin.js';

/** Maximum bytes of tool output before truncation. */
const MAX_OUTPUT_BYTES = 32_000;
/** Per-tool execution timeout in ms. */
const TOOL_TIMEOUT_MS = 30_000;

/**
 * Safely runs a CLI command via execFile (no shell interpolation).
 * Never throws — returns `[error] ...` strings on failure so the model
 * sees the error as tool output rather than crashing the run.
 */
function runCli(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      resolveBin(cmd),
      args,
      { cwd, timeout: TOOL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES * 2 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message;
          resolve(`[error] ${cmd} failed: ${msg}`);
          return;
        }
        let output = stdout;
        if (output.length > MAX_OUTPUT_BYTES) {
          output = output.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
        }
        resolve(output);
      },
    );
  });
}

/**
 * Creates the fsuite tool definitions scoped to a working directory.
 *
 * @param cwd - The project working directory for all tool invocations
 * @returns Array of FunctionTool instances for the Agent constructor
 */
export function createFsuiteTools(cwd: string) {
  return [
    tool({
      name: 'ftree',
      description:
        'Show a tree view of the project directory structure. ' +
        'Accepts optional flags: --depth <n>, --show-hidden, --show-size, --dirs-only, ' +
        '--filter <glob>, --hide-excluded. No arguments = full tree from cwd.',
      parameters: z.object({
        args: z
          .string()
          .optional()
          .describe('CLI arguments, e.g. "--depth 2 --show-size" or "src/"'),
      }),
      execute: async (input) => {
        const args = input.args ? input.args.split(/\s+/) : [];
        return runCli('ftree', args, cwd);
      },
    }),

    tool({
      name: 'fsearch',
      description:
        'Fast filename and path search using glob patterns and extensions (NOT content search). ' +
        "Usage: fsearch <pattern_or_ext> [path]. " +
        "Pattern examples: 'upscale*' (starts-with), '*progress*' (contains), " +
        "'.log' or 'log' (extension search), '*error' (ends-with). " +
        'Flags: -m <n> (max results), -o pretty|paths|json (output format), -b auto|find|fd (backend).',
      parameters: z.object({
        query: z.string().describe("Glob pattern or file extension to search for, e.g. '*.ts', 'config*', '.log'"),
        args: z
          .string()
          .optional()
          .describe('Additional CLI arguments, e.g. "--output json --max 20 src/"'),
      }),
      execute: async (input) => {
        const args = [input.query];
        if (input.args) args.push(...input.args.split(/\s+/));
        return runCli('fsearch', args, cwd);
      },
    }),

    tool({
      name: 'fcontent',
      description:
        'Search file contents for matching text (grep-like). ' +
        'The query argument is a search term, NOT a file path. ' +
        'Returns matching lines with context. ' +
        'Usage: fcontent <query> — searches for the query text across files in the working directory.',
      parameters: z.object({
        query: z.string().describe('Text pattern to search for in file contents'),
      }),
      execute: async (input) => {
        return runCli('fcontent', [input.query], cwd);
      },
    }),

    tool({
      name: 'fmap',
      description:
        'Code cartography — extract symbols (functions, classes, types, imports) from source files. ' +
        'Supports 15+ languages. Usage: fmap [path] [flags]. ' +
        'Flags: --imports, --depth <n>, --type <ext>.',
      parameters: z.object({
        args: z
          .string()
          .optional()
          .describe('CLI arguments, e.g. "src/ --imports" or "--type ts --depth 2"'),
      }),
      execute: async (input) => {
        const args = input.args ? input.args.split(/\s+/) : [];
        return runCli('fmap', args, cwd);
      },
    }),

    tool({
      name: 'fmetrics',
      description:
        'Code metrics — lines of code, comment ratio, complexity estimates per file or directory. ' +
        'Usage: fmetrics [path] [flags]. Flags: --type <ext>, --sort <metric>, --top <n>.',
      parameters: z.object({
        args: z
          .string()
          .optional()
          .describe('CLI arguments, e.g. "src/ --sort loc --top 10"'),
      }),
      execute: async (input) => {
        const args = input.args ? input.args.split(/\s+/) : [];
        return runCli('fmetrics', args, cwd);
      },
    }),
  ];
}
