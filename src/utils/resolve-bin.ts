import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const cache = new Map<string, string>();
const isWin = process.platform === 'win32';

function getSearchDirs(): string[] {
  const home = os.homedir();

  switch (process.platform) {
    case 'win32':
      return [
        path.join(home, 'scoop', 'shims'),
        path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'yt-dlp'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
        path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'),
      ];
    case 'darwin':
      return [
        '/opt/homebrew/bin',        // Apple Silicon Homebrew
        '/usr/local/bin',           // Intel Homebrew
        '/usr/bin',
        path.join(home, '.local', 'bin'),
      ];
    default: // linux, freebsd, etc.
      return [
        path.join(home, '.local', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/snap/bin',
      ];
  }
}

const SEARCH_DIRS = getSearchDirs();

/**
 * Resolve a binary name to its full path.
 * Checks platform-specific install locations so execFile works under
 * systemd, launchd, and other environments with minimal PATH.
 */
export function resolveBin(name: string): string {
  // Reject names with path separators to prevent traversal
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid binary name: ${name}`);
  }

  const cached = cache.get(name);
  if (cached) return cached;

  // Try the platform's lookup command first (works when PATH is correct)
  try {
    const cmd = isWin ? 'where' : 'which';
    const result = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 }).trim();
    // `where` on Windows can return multiple lines — take the first
    const resolved = result.split(/\r?\n/)[0];
    if (resolved) {
      cache.set(name, resolved);
      return resolved;
    }
  } catch { /* lookup failed or not found */ }

  // Check platform-specific directories
  const suffixes = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of SEARCH_DIRS) {
    for (const ext of suffixes) {
      const fullPath = path.join(dir, name + ext);
      try {
        fs.accessSync(fullPath, isWin ? fs.constants.F_OK : fs.constants.X_OK);
        cache.set(name, fullPath);
        return fullPath;
      } catch { /* not found or not executable */ }
    }
  }

  // Fall back to bare name (let execFile try PATH as last resort)
  return name;
}
