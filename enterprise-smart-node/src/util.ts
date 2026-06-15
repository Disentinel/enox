import { createHash, randomBytes } from 'node:crypto';

export function nanoid(size = 12): string {
  return randomBytes(size).toString('base64url').slice(0, size);
}

export function computeFactId(source: string, relation: string, target: string): string {
  return createHash('sha256')
    .update(`${source}|${relation}|${target}`)
    .digest('hex');
}
