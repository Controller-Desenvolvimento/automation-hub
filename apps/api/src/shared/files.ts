import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

// Multer/busboy reads HTTP header bytes as Latin-1. Modern browsers send
// filenames as raw UTF-8 bytes, so the result is a Latin-1 string whose
// char codes are the UTF-8 byte values. Re-encode to recover the real name.
export function fixMulterFilename(name: string): string {
  if (!name || /^[\x00-\x7F]*$/.test(name)) return name; // pure ASCII — no fix needed
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // Only accept if it's valid UTF-8 (no replacement chars from bad sequences)
    if (!decoded.includes('\uFFFD')) return decoded;
  } catch {}
  return name;
}

export function sanitizeFileName(value: string) {
  // Strip chars forbidden in Windows/NTFS paths: backslash (separate replace to
  // avoid linter removing \ from the char class), C0 controls (U+0000-U+001F),
  // and C1 controls (U+0080-U+009F) which appear from Latin-1/UTF-8 misinterpretation.
  return value
    .replace(/[\\]/g, '-')
    .replace(/[<>:"/|?*\u0000-\u001F\u0080-\u009F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toUserFileName(value: string) {
  const clean = sanitizeFileName(value || 'arquivo');
  const withoutPrefixes = clean.replace(/^(?:\d{13}-[a-z0-9]{6}-)+/i, '');
  return withoutPrefixes || clean;
}

export function uniqueStoredFileName(originalName: string) {
  const clean = sanitizeFileName(originalName || 'arquivo');
  const extension = extname(clean);
  const name = basename(clean, extension);
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}${extension}`;
}

export async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return listFilesRecursively(fullPath);
      }

      return [fullPath];
    }),
  );

  return files.flat();
}
