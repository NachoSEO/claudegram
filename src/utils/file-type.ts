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
  // BMP — check 6 bytes: "BM" magic + verify reserved bytes at offset 6-7 are zero
  { bytes: [0x42, 0x4D], extension: '.bmp', mimeType: 'image/bmp' },
  // TIFF (little endian)
  { bytes: [0x49, 0x49, 0x2A, 0x00], extension: '.tiff', mimeType: 'image/tiff' },
  // TIFF (big endian)
  { bytes: [0x4D, 0x4D, 0x00, 0x2A], extension: '.tiff', mimeType: 'image/tiff' },
  // NOTE: WebP is handled by dedicated isWebP() check, not in this array.
  // NOTE: HEIC/HEIF removed — the old [0x00,0x00,0x00] signature was a false-positive
  // magnet (matches any file starting with null bytes). Proper HEIC detection requires
  // checking for "ftyp" at offset 4 and brand codes at offset 8.
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
 * Check for HEIC/HEIF by verifying the ISO BMFF ftyp box structure.
 * Bytes 4-7 must be "ftyp", and the brand at bytes 8-11 must be a known HEIC brand.
 */
function isHEIC(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // Bytes 4-7: "ftyp"
  if (buffer[4] !== 0x66 || buffer[5] !== 0x74 || buffer[6] !== 0x79 || buffer[7] !== 0x70) return false;
  // Bytes 8-11: brand (heic, heix, mif1, msf1)
  const brand = buffer.slice(8, 12).toString('ascii');
  return ['heic', 'heix', 'mif1', 'msf1'].includes(brand);
}

/**
 * Additional BMP validation: reserved bytes at offset 6-9 should be zero.
 */
function isBMP(buffer: Buffer): boolean {
  if (buffer.length < 10) return false;
  if (buffer[0] !== 0x42 || buffer[1] !== 0x4D) return false;
  // Reserved fields at bytes 6-9 must be zero in valid BMP files
  return buffer[6] === 0 && buffer[7] === 0 && buffer[8] === 0 && buffer[9] === 0;
}

/**
 * Detect file type from magic bytes.
 * Returns null if the file type is not recognized as an image.
 */
export function detectImageType(buffer: Buffer): FileTypeResult | null {
  // Check WebP first (special case — shares RIFF header with WAV/AVI)
  if (isWebP(buffer)) {
    return { extension: '.webp', mimeType: 'image/webp' };
  }

  // Check HEIC (proper ftyp box validation)
  if (isHEIC(buffer)) {
    return { extension: '.heic', mimeType: 'image/heic' };
  }

  // Check BMP with reserved-byte validation (avoids 2-byte false positives)
  if (isBMP(buffer)) {
    return { extension: '.bmp', mimeType: 'image/bmp' };
  }

  // Check other signatures
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.extension === '.bmp') continue; // Already checked above
    if (matchesSignature(buffer, sig.bytes)) {
      return { extension: sig.extension, mimeType: sig.mimeType };
    }
  }

  return null;
}

function readHeaderBytes(filePath: string, length = 16): { buffer: Buffer; bytesRead: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return { buffer, bytesRead };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Validate that a file is actually an image by checking magic bytes.
 * @param filePath Path to the file to validate
 * @returns true if the file is a valid image, false otherwise
 */
export function isValidImageFile(filePath: string): boolean {
  try {
    const { buffer, bytesRead } = readHeaderBytes(filePath);

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
    const { buffer, bytesRead } = readHeaderBytes(filePath);

    if (bytesRead < 2) return null;

    return detectImageType(buffer);
  } catch {
    return null;
  }
}
