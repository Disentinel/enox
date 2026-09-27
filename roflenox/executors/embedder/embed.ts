// The embedding models of the embedder executor.
//
// LEARNED (the default): a multilingual sentence encoder run locally through
// @huggingface/transformers (ONNX, int8) — Xenova/multilingual-e5-small, 384
// dimensions, ~130 MB, Russian and English among ~100 languages. It matches
// by meaning: "attorney for ending a marriage" finds a fact about divorces.
// Any other feature-extraction model is ROFLENOX_EMBED_MODEL=<hub name>; the
// old Enox node used bge-m3 (better, ~570 MB). The model is fetched once into
// ROFLENOX_MODEL_CACHE (default: .models/ beside this file) — `npm run
// fetch-model` does it ahead; after that nothing leaves the machine.
//
// HASH (ROFLENOX_EMBED_MODEL=hash): no dependencies and no model — words and
// their character trigrams, feature-hashed. It matches shared words and word
// parts only, NOT meaning; it exists so the core's own suite can run an
// embedder with neither the network nor a model.
//
// A model's `id` is part of every embedding's key, so a model change re-embeds
// instead of mixing vectors from two models.
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** A query and the passages it is matched against may be embedded
 *  differently (e5 is trained with "query: " and "passage: " prefixes). */
export type Role = 'query' | 'passage';
export interface Model { id: string; embed(texts: string[], role: Role): Promise<Float32Array[]> }

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

export const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
export const MODEL_CACHE = process.env.ROFLENOX_MODEL_CACHE ?? path.join(import.meta.dirname, '.models');

/** A learned sentence encoder. Loaded on first use; the dependency is
 *  imported only here, so the hash model needs no install at all. */
export async function learned(name: string = DEFAULT_MODEL): Promise<Model> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = MODEL_CACHE;
  const extract = await pipeline('feature-extraction', name, { dtype: 'q8' });
  const e5 = /e5/i.test(name);
  return {
    id: `${name}:q8`,
    embed: async (texts, role) => {
      if (texts.length === 0) return [];
      const out = await extract(texts.map((t) => (e5 ? `${role}: ${t}` : t)), { pooling: 'mean', normalize: true });
      const dims = out.dims[1]!;
      const data = out.data as Float32Array;
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    },
  };
}

/** The model this process uses: ROFLENOX_EMBED_MODEL, "hash", or the default. */
export async function modelFromEnv(): Promise<Model> {
  const name = process.env.ROFLENOX_EMBED_MODEL ?? DEFAULT_MODEL;
  return name === 'hash' ? HASH : learned(name);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** A vector as a fact's target: its largest magnitude (float32), then each
 *  component int8-quantised against it; base64url. ~4x smaller than float32. */
export function encode(v: Float32Array): string {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const b = Buffer.alloc(4 + v.length);
  b.writeFloatLE(max, 0);
  for (let i = 0; i < v.length; i++) b.writeInt8(max === 0 ? 0 : Math.round((v[i]! / max) * 127), 4 + i);
  return b.toString('base64url');
}

export function decode(s: string): Float32Array {
  const b = Buffer.from(s, 'base64url');
  const max = b.readFloatLE(0);
  return Float32Array.from({ length: b.length - 4 }, (_, i) => (b.readInt8(4 + i) / 127) * max);
}

/** The key of an embedding: the model and the exact text embedded. */
export function embeddingKey(model: string, text: string): string {
  return `embedding:${createHash('sha256').update(`${model}\n${text}`).digest('hex').slice(0, 32)}`;
}
