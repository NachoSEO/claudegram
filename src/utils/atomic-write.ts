import * as fs from 'fs';

/**
 * Write a file atomically using write-to-temp + rename.
 * On POSIX, rename is atomic. On Windows, it's best-effort but still
 * safer than a direct writeFileSync which can corrupt on crash.
 */
export function atomicWriteFileSync(
  filePath: string,
  data: string,
  options?: { mode?: number },
): void {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, data, { mode: options?.mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
