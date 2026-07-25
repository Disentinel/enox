// Blob storage for artifacts: metadata + path live in sqlite (see store.ts),
// the body itself lives on disk at data/artifacts/<id>.<ext> — same pattern
// as share snapshots (src/shares/snapshot.ts), which resolve their directory
// relative to KUZU_DB_PATH's parent so tests (which point KUZU_DB_PATH at a
// throwaway temp dir) never touch the real data/ directory.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ARTIFACTS_DIR = path.resolve(process.env.KUZU_DB_PATH ?? './data/enox.db', '..', 'artifacts');

// Known content-type -> file extension. Anything unrecognized falls back to
// the extension on an explicitly provided filename, then to 'bin' — the
// artifact is stored as an opaque blob either way, this only affects the
// on-disk filename and has no bearing on correctness.
const EXT_BY_MIME: Record<string, string> = {
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/xml': 'xml',
  'text/yaml': 'yaml',
  'text/javascript': 'js',
  'text/x-typescript': 'ts',
  'text/x-python': 'py',
  'application/json': 'json',
  'application/javascript': 'js',
  'application/typescript': 'ts',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

export function extFor(contentType: string, filename?: string): string {
  if (filename) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(filename);
    if (m) return m[1].toLowerCase();
  }
  const base = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[base] ?? 'bin';
}

export function blobPath(id: string, contentType: string, filename?: string): string {
  return path.join(ARTIFACTS_DIR, `${id}.${extFor(contentType, filename)}`);
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function writeBlob(filePath: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

export function readBlob(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export function deleteBlob(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

// Decodes the request body per the caller-declared encoding. 'base64' exists
// so binary content-types (images, PDFs, zips) can round-trip through JSON
// without a separate multipart upload path (not implemented this phase).
export function decodeBody(body: string, encoding: 'utf8' | 'base64'): Buffer {
  return encoding === 'base64' ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}
