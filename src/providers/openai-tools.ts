/**
 * Custom tools for the OpenAI Agents SDK.
 *
 * Provides two tiers:
 *   - Always: fsuite CLI tools (ftree, fsearch, fcontent, fmap, fmetrics) + read_file
 *   - DANGEROUS_MODE only: shellTool (exec) + applyPatchTool (file editing)
 *
 * Shell tool uses child_process.exec intentionally — Shell.run() receives full
 * command strings that may contain pipes, redirects, etc. This is gated behind
 * DANGEROUS_MODE=true, matching Claude provider's bypassPermissions behavior.
 */

import { exec, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { tool, shellTool, applyPatchTool } from '@openai/agents';
import { z } from 'zod';

import { resolveBin } from '../utils/resolve-bin.js';

import type { Shell, ShellAction, ShellResult, ShellOutputResult } from '@openai/agents';
import type { Editor, ApplyPatchResult } from '@openai/agents';
import type { Tool } from '@openai/agents-core';

/** Maximum bytes of tool output before truncation. */
const MAX_OUTPUT_BYTES = 32_000;
/** Per-tool execution timeout in ms. */
const TOOL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
//  Path validation
// ---------------------------------------------------------------------------

/** Basename patterns for sensitive files. */
const SECRET_BASENAME_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.key$/,
  /\.pem$/,
  /^id_rsa/,
  /^credentials\.json$/,
  /^auth\.json$/,
  /^tokens\.json$/,
  /^secrets\./,
];

/** Directory segments that indicate auth/key material. */
const SECRET_DIR_SEGMENTS = [
  '/.ssh/',
  '/.gnupg/',
  '/.codex/',
  '/.aws/',
  '/.config/gcloud/',
];

/**
 * Validates that a target path is safely within the project root.
 * Uses realpathSync on the canonical root and resolves the target
 * against it to prevent symlink escapes and prefix collisions.
 *
 * @param cwd - Project working directory
 * @param targetPath - Path to validate (may be relative or absolute)
 * @param allowNew - If true, validates parent dir for files that don't exist yet
 * @returns The canonical absolute path if valid
 * @throws Error if path escapes the project root
 */
function validatePath(cwd: string, targetPath: string, allowNew = false): string {
  const canonicalRoot = fs.realpathSync(cwd);
  const resolved = path.resolve(cwd, targetPath);

  let canonical: string;
  if (allowNew && !fs.existsSync(resolved)) {
    // For new files: validate the parent directory exists and is within root
    const parentDir = path.dirname(resolved);
    if (!fs.existsSync(parentDir)) {
      // Parent doesn't exist yet — walk up to find the deepest existing ancestor
      let ancestor = parentDir;
      while (!fs.existsSync(ancestor)) {
        const next = path.dirname(ancestor);
        if (next === ancestor) break; // filesystem root
        ancestor = next;
      }
      const canonicalAncestor = fs.realpathSync(ancestor);
      const rel = path.relative(canonicalRoot, canonicalAncestor);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`[denied] Path escapes project root: ${targetPath}`);
      }
    } else {
      const canonicalParent = fs.realpathSync(parentDir);
      const rel = path.relative(canonicalRoot, canonicalParent);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`[denied] Path escapes project root: ${targetPath}`);
      }
    }
    canonical = resolved; // file doesn't exist yet, use resolved path
  } else {
    canonical = fs.realpathSync(resolved);
    const rel = path.relative(canonicalRoot, canonical);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`[denied] Path escapes project root: ${targetPath}`);
    }
  }

  return canonical;
}

/**
 * Checks if a resolved path points to a sensitive file.
 * Matches against basename patterns and directory segments.
 */
function isSensitiveFile(resolvedPath: string): boolean {
  const basename = path.basename(resolvedPath);
  for (const pattern of SECRET_BASENAME_PATTERNS) {
    if (pattern.test(basename)) return true;
  }
  for (const segment of SECRET_DIR_SEGMENTS) {
    if (resolvedPath.includes(segment)) return true;
  }
  return false;
}

/**
 * Byte-aware string truncation. Uses Buffer.byteLength to avoid
 * clipping multibyte UTF-8 characters.
 */
function truncateByBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  // Binary search for the right character boundary
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(str.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo) + '\n... [truncated]';
}

// ---------------------------------------------------------------------------
//  CLI runner (fsuite tools)
// ---------------------------------------------------------------------------

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
        resolve(truncateByBytes(stdout, MAX_OUTPUT_BYTES));
      },
    );
  });
}

// ---------------------------------------------------------------------------
//  Shell implementation (DANGEROUS_MODE only)
// ---------------------------------------------------------------------------

/**
 * Local Shell implementation for the Agents SDK shellTool.
 * Executes commands via child_process.exec (supports pipes, redirects, etc.)
 * with timeout and byte-aware output truncation.
 *
 * Uses exec() intentionally — Shell.run() receives full shell command strings.
 * Gated behind DANGEROUS_MODE=true at tool registration level.
 */
class LocalShell implements Shell {
  constructor(private readonly cwd: string) {}

  async run(action: ShellAction): Promise<ShellResult> {
    const timeout = action.timeoutMs ?? TOOL_TIMEOUT_MS;
    const maxOutput = action.maxOutputLength ?? MAX_OUTPUT_BYTES;
    const output: ShellOutputResult[] = [];

    for (const command of action.commands) {
      const result = await this.execCommand(command, timeout, maxOutput);
      output.push(result);
    }

    return { output, maxOutputLength: maxOutput };
  }

  private execCommand(
    command: string,
    timeout: number,
    maxOutput: number,
  ): Promise<ShellOutputResult> {
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: this.cwd, timeout, maxBuffer: maxOutput * 2 },
        (error, stdout, stderr) => {
          const exitCode = error
            ? ('code' in error && typeof error.code === 'number' ? error.code : 1)
            : 0;
          resolve({
            stdout: truncateByBytes(String(stdout), maxOutput),
            stderr: truncateByBytes(String(stderr), maxOutput),
            outcome: { type: 'exit', exitCode },
          });
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
//  Editor implementation (DANGEROUS_MODE only)
// ---------------------------------------------------------------------------

/**
 * Local Editor implementation for the Agents SDK applyPatchTool.
 * Handles create/update/delete file operations with V4A unified diffs.
 * All paths validated against the project root via realpathSync.
 */
class LocalEditor implements Editor {
  constructor(private readonly cwd: string) {}

  async createFile(
    operation: { type: 'create_file'; path: string; diff: string },
  ): Promise<ApplyPatchResult> {
    try {
      const target = validatePath(this.cwd, operation.path, true);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // V4A diff for create_file contains the full file content after the diff header
      const content = extractContentFromDiff(operation.diff);
      await fs.promises.writeFile(target, content, 'utf8');
      return { status: 'completed', output: `Created ${operation.path}` };
    } catch (err) {
      return { status: 'failed', output: String(err instanceof Error ? err.message : err) };
    }
  }

  async updateFile(
    operation: { type: 'update_file'; path: string; diff: string },
  ): Promise<ApplyPatchResult> {
    try {
      const target = validatePath(this.cwd, operation.path);
      const original = await fs.promises.readFile(target, 'utf8');
      const patched = applyUnifiedDiff(original, operation.diff);
      await fs.promises.writeFile(target, patched, 'utf8');
      return { status: 'completed', output: `Updated ${operation.path}` };
    } catch (err) {
      return { status: 'failed', output: String(err instanceof Error ? err.message : err) };
    }
  }

  async deleteFile(
    operation: { type: 'delete_file'; path: string },
  ): Promise<ApplyPatchResult> {
    try {
      const target = validatePath(this.cwd, operation.path);
      await fs.promises.unlink(target);
      return { status: 'completed', output: `Deleted ${operation.path}` };
    } catch (err) {
      return { status: 'failed', output: String(err instanceof Error ? err.message : err) };
    }
  }
}

/**
 * Extracts file content from a V4A create_file diff.
 * Lines starting with '+' (after the @@ header) contain the new content.
 */
function extractContentFromDiff(diff: string): string {
  const lines = diff.split('\n');
  const contentLines: string[] = [];
  let inContent = false;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inContent = true;
      continue;
    }
    if (inContent && line.startsWith('+')) {
      contentLines.push(line.slice(1));
    }
  }

  return contentLines.join('\n');
}

/**
 * Applies a V4A unified diff to original file content.
 * Handles context lines (space-prefixed), additions (+), and removals (-).
 */
function applyUnifiedDiff(original: string, diff: string): string {
  const originalLines = original.split('\n');
  const diffLines = diff.split('\n');
  const result: string[] = [];
  let originalIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];

    // Parse hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunkMatch) {
      const hunkStart = Math.max(parseInt(hunkMatch[1], 10) - 1, originalIdx); // 0-indexed, clamp to current position
      // Copy lines before this hunk
      while (originalIdx < hunkStart) {
        result.push(originalLines[originalIdx]);
        originalIdx++;
      }
      continue;
    }

    // Skip diff header lines
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')) {
      continue;
    }

    if (line.startsWith('-')) {
      // Remove line — skip it in original
      originalIdx++;
    } else if (line.startsWith('+')) {
      // Add line
      result.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      // Context line — verify match, then copy from original
      const expected = line.slice(1);
      const actual = originalLines[originalIdx];
      if (actual !== expected) {
        throw new Error(
          `Diff context mismatch at line ${originalIdx + 1}: ` +
          `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
      result.push(actual);
      originalIdx++;
    }
  }

  // Copy remaining original lines after last hunk
  while (originalIdx < originalLines.length) {
    result.push(originalLines[originalIdx]);
    originalIdx++;
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
//  read_file tool (always available)
// ---------------------------------------------------------------------------

function createReadFileTool(cwd: string) {
  return tool({
    name: 'read_file',
    description:
      'Read a file from the project directory. Returns contents with line numbers. ' +
      'The path must be relative to the project root or an absolute path within it. ' +
      'Cannot read sensitive files (.env, keys, credentials).',
    parameters: z.object({
      path: z.string().describe('File path relative to project root, e.g. "src/config.ts"'),
      offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
      limit: z.number().optional().describe('Maximum number of lines to read'),
    }),
    execute: async (input) => {
      try {
        const target = validatePath(cwd, input.path);

        if (isSensitiveFile(target)) {
          return '[denied] Cannot read sensitive files';
        }

        const stat = await fs.promises.stat(target);
        if (stat.isDirectory()) {
          return '[error] Path is a directory, not a file. Use ftree to explore directories.';
        }

        const content = await fs.promises.readFile(target, 'utf8');
        let lines = content.split('\n');

        const offset = Math.max(0, (input.offset ?? 1) - 1); // convert to 0-indexed, clamp
        const limit = input.limit ?? lines.length;
        lines = lines.slice(offset, offset + limit);

        // Format with line numbers matching Claude's Read tool format
        const formatted = lines
          .map((line, i) => {
            const lineNum = String(offset + i + 1).padStart(6, ' ');
            return `${lineNum}→${line}`;
          })
          .join('\n');

        return truncateByBytes(formatted, MAX_OUTPUT_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[error] read_file failed: ${msg}`;
      }
    },
  });
}

// ---------------------------------------------------------------------------
//  fsuite tool definitions
// ---------------------------------------------------------------------------

function createFsuiteOnlyTools(cwd: string) {
  return [
    tool({
      name: 'ftree',
      description:
        'Show a tree view of the project directory structure. ' +
        'Flags: -L <n> (depth, default 3), -o pretty|paths|json (output format), ' +
        '-d (dirs only), -s (show sizes), -r/--recon (per-dir item counts + sizes), ' +
        '--snapshot (combined recon + tree), -I <pattern> (extra ignores), ' +
        '--include <name> (un-ignore a dir), --hide-excluded (suppress excluded summaries). ' +
        'No arguments = full tree from cwd at depth 3.',
      parameters: z.object({
        args: z
          .string()
          .optional()
          .describe('CLI arguments, e.g. "-L 5 src/" or "--recon -o json" or "--snapshot"'),
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
        'Supports 12 languages (Python, JS, TS, Rust, Go, Java, C, C++, Ruby, Lua, PHP, Bash). ' +
        'Modes: fmap <dir> (scan all files), fmap <file> (single file), piped: fsearch -o paths "*.py" | fmap. ' +
        'Flags: -o pretty|paths|json, -t <type> (function|class|import|type|export|constant), ' +
        '-L <lang> (force language), -m <n> (max symbols), -n <n> (max files), --no-imports.',
      parameters: z.object({
        args: z
          .string()
          .optional()
          .describe('CLI arguments, e.g. "src/" or "-t function -o json" or "-L python src/"'),
      }),
      execute: async (input) => {
        const args = input.args ? input.args.split(/\s+/) : [];
        return runCli('fmap', args, cwd);
      },
    }),

    tool({
      name: 'fmetrics',
      description:
        'Performance telemetry and analytics for fsuite tools. ' +
        'Subcommands: stats (usage dashboard), history (recent runs), predict <path> (estimate runtimes), ' +
        'profile (machine info), import (ingest telemetry), clean (prune old data). ' +
        'Flags: -o pretty|json. History: --tool <name>, --project <name>, --limit <n>. ' +
        'Predict: --tool <name>. Clean: --days <n>, --dry-run.',
      parameters: z.object({
        args: z
          .string()
          .optional()
          .describe('CLI arguments, e.g. "stats -o json" or "history --tool ftree --limit 10" or "predict /project"'),
      }),
      execute: async (input) => {
        const args = input.args ? input.args.split(/\s+/) : [];
        return runCli('fmetrics', args, cwd);
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

/**
 * Creates tool definitions scoped to a working directory.
 *
 * @param cwd - The project working directory for all tool invocations
 * @param dangerousMode - When true, includes shell and file editing tools
 * @returns Array of tool instances for the Agent constructor
 */
export function createFsuiteTools(cwd: string, dangerousMode: boolean): Tool[] {
  const tools: Tool[] = [
    ...createFsuiteOnlyTools(cwd),
    createReadFileTool(cwd),
  ];

  if (dangerousMode) {
    const shell = new LocalShell(cwd);
    const editor = new LocalEditor(cwd);

    tools.push(
      shellTool({ shell, needsApproval: false }),
      applyPatchTool({ editor, needsApproval: false }),
    );
  }

  return tools;
}
