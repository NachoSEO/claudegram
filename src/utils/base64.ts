import * as fs from 'node:fs';

/** Read a file and return base64 string (no data: prefix). */
export function fileToBase64(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return buf.toString('base64');
}
