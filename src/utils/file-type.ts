import * as fs from 'fs';

/**
 * Common image file magic bytes (signatures)
 */
const IMAGE_SIGNATURES: { bytes: number[]; extension: string; mimeType: string }[] = [
  // JPEG
  { bytes: [0xFF, 0xD8, 0xFF], extension: '.jpg', mimeType: 'image/jpeg' },
  // PNG
  { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], extension: '.png', mimeType: 'image/png' },
  // GIF87a
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], extension: '.gif', mimeType: 'image/gif' },
  // GIF89a
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], extension: '.gif', mimeType: 'image/gif' },
  // WebP (RIFF....WEBP)
  { bytes: [0x52, 0x49, 0x46, 0x46], extension: '.webp', mimeType: 'image/webp' },
  // BMP
  { bytes: [0x42, 0x4D], extension: '.bmp', mimeType: 'image/bmp' },
  // TIFF (little endian)
  { bytes: [0x49, 0x49, 0x2A, 0x00], extension: '.tiff', mimeType: 'image/tiff' },
  // TIFF (big endian)
  { bytes: [0x4D, 0x4D, 0x00, 0x2A], extension: '.tiff', mimeType: 'image/tiff' },
  // HEIC/HEIF (ftyp)
  { bytes: [0x00, 0x00, 0x00], extension: '.heic', mimeType: 'image/heic' }, // Partial match, needs ftyp check
];

export interface FileTypeResult {
  extension: string;
  mimeType: string;
}

/**
 * Check if a buffer starts with the given signature bytes.
 */
function matchesSignature(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Special check for WebP which has RIFF header followed by WEBP at bytes 8-11.
 */
function isWebP(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // Check RIFF header
  if (!matchesSignature(buffer, [0x52, 0x49, 0x46, 0x46])) return false;
  // Check WEBP signature at offset 8
  return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
}

/**
 * Detect file type from magic bytes.
 * Returns null if the file type is not recognized as an image.
 */
export function detectImageType(buffer: Buffer): FileTypeResult | null {
  // Check WebP first (special case)
  if (isWebP(buffer)) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }

  // Check other signatures
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.extension === '.webp') continue; // Already checked
    if (matchesSignature(buffer, sig.bytes)) {
      return { extension: sig.extension, mimeType: sig.mimeType };
    }
  }

  return null;
}

/**
 * Validate that a file is actually an image by checking magic bytes.
 * @param filePath Path to the file to validate
 * @returns true if the file is a valid image, false otherwise
 */
export function isValidImageFile(filePath: string): boolean {
  try {
    // Read first 16 bytes (enough for any signature)
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    if (bytesRead < 2) return false;

    return detectImageType(buffer) !== null;
  } catch {
    return false;
  }
}

/**
 * Get the actual file type from magic bytes.
 * @param filePath Path to the file
 * @returns FileTypeResult or null if not recognized
 */
export function getFileType(filePath: string): FileTypeResult | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    if (bytesRead < 2) return null;

    return detectImageType(buffer);
  } catch {
    return null;
  }
}
