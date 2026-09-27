// The embedding model of the embedder executor. HASH is the built-in one: no
// dependencies, deterministic, and so reproducible from primary data alone —
// words and their character trigrams, feature-hashed into 256 signed
// dimensions and normalised. It matches by shared words and word parts
// (tabulate ~ tables), not by learned meaning; a learned model plugs in as
// another `Model` (this package may take the dependency; the core never does).
// A model's `id` is part of every embedding's key, so a model change re-embeds
// instead of mixing vectors from two models.
import { createHash } from 'node:crypto';

export interface Model { id: string; embed(texts: string[]): Promise<Float32Array[]> }

const DIMS = 256;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function words(text: string): string[] {
  return text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  const add = (feature: string, w: number) => {
    const h = fnv1a(feature);
    v[h % DIMS]! += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (const w of words(text)) {
    add(`w:${w}`, 1);
    const b = `<${w}>`;
    for (let i = 0; i + 3 <= b.length; i++) add(`t:${b.slice(i, i + 3)}`, 0.5);
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < DIMS; i++) v[i]! /= n;
  return v;
}

export const HASH: Model = { id: 'hash-256-v1', embed: async (texts) => texts.map(hashEmbed) };

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** A vector as a fact's target: int8-quantised, base64url. */
export function encode(v: Float32Array): string {
  return Buffer.from(Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127)))).buffer).toString('base64url');
}

export function decode(s: string): Float32Array {
  const b = Buffer.from(s, 'base64url');
  return Float32Array.from(new Int8Array(b.buffer, b.byteOffset, b.length), (x) => x / 127);
}

/** The key of an embedding: the model and the exact text embedded. */
export function embeddingKey(model: string, text: string): string {
  return `embedding:${createHash('sha256').update(`${model}\n${text}`).digest('hex').slice(0, 32)}`;
}
