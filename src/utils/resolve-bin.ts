import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cache = new Map<string, string>();

const SEARCH_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/snap/bin',
];

/**
 * Resolve a binary name to its full path.
 * Checks common install locations so execFile works under systemd
 * and other environments with minimal PATH.
 */
export function resolveBin(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;

  // Try `which` first (works when PATH is correct)
  try {
    const result = execFileSync('which', [name], { encoding: 'utf8', timeout: 3000 }).trim();
    if (result) {
      cache.set(name, result);
      return result;
    }
  } catch { /* which failed or not found */ }

  // Check common directories
  for (const dir of SEARCH_DIRS) {
    const fullPath = path.join(dir, name);
    if (fs.existsSync(fullPath)) {
      cache.set(name, fullPath);
      return fullPath;
    }
  }

  // Fall back to bare name (let execFile try PATH as last resort)
  return name;
}
