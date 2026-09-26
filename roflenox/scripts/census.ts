// The census (r_minimal_parts): one process, one log, one engine, one wire
// format (the signed batch, carried as JSON), one proof of who (an identity
// signature). This scans src/ for every place that could be a SECOND one of
// these — a write to disk, a queue or timer loop, a non-JSON wire format, a
// check of who someone is — and compares what it finds with
// scripts/census.json, where every place that is allowed is listed with its
// reason. Anything found and not listed, or listed and no longer found, fails.
//
//   npm run census
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SIGNATURES: Record<string, RegExp> = {
  // Any receiver: `fs.x(`, `(await import('node:fs')).x(`, a renamed import.
  store: /\.(writeFile|writeFileSync|writeSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|copyFile|copyFileSync|cpSync|mkdtempSync)\s*\(|node:sqlite|sqlite3|leveldb|lmdb|indexedDB|localStorage/g,
  queue: /\bsetInterval\s*\(|new\s+Worker\b|MessageChannel|BroadcastChannel|\bqueue\b/g,
  wire: /['"]content-type['"]\s*:\s*['"][^'"]+['"]|msgpack|protobuf|\bcbor\b|\bbson\b|XMLParser|text\/event-stream/gi,
  who: /crypto\.verify\(|timingSafeEqual|createHmac|Bearer|headers\.(authorization|cookie)|headers\[['"](authorization|cookie|x-[a-z-]+)['"]\]|['"]x-api-key['"]/g,
};

export interface Finding { file: string; kind: string; match: string }

export function scan(files: Record<string, string>): Finding[] {
  const out = new Map<string, Finding>();
  for (const [file, text] of Object.entries(files)) {
    const code = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');   // comments do not count
    for (const [kind, re] of Object.entries(SIGNATURES)) {
      for (const m of code.matchAll(re)) {
        const f = { file, kind, match: m[0] };
        out.set(`${file}\u0000${kind}\u0000${m[0]}`, f);
      }
    }
  }
  return [...out.values()].sort((a, b) => `${a.file}${a.kind}${a.match}`.localeCompare(`${b.file}${b.kind}${b.match}`));
}

export function sources(root: string): Record<string, string> {
  const dir = path.join(root, 'src');
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [`src/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

export interface Allowed extends Finding { why: string }

export function compare(found: Finding[], allowed: Allowed[]): { extra: Finding[]; stale: Allowed[] } {
  const key = (f: Finding) => `${f.file}\u0000${f.kind}\u0000${f.match}`;
  const a = new Set(allowed.map(key));
  const g = new Set(found.map(key));
  return { extra: found.filter((f) => !a.has(key(f))), stale: allowed.filter((f) => !g.has(key(f))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.join(import.meta.dirname, '..');
  const allowed = (JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'census.json'), 'utf8')) as { allowed: Allowed[] }).allowed;
  const found = scan(sources(root));
  const { extra, stale } = compare(found, allowed);
  for (const f of extra) process.stdout.write(`NOT IN THE CENSUS  ${f.kind}  ${f.file}  ${f.match}\n`);
  for (const f of stale) process.stdout.write(`NO LONGER FOUND    ${f.kind}  ${f.file}  ${f.match}\n`);
  process.stdout.write(`${found.length} places, ${extra.length} unlisted, ${stale.length} stale\n`);
  process.exit(extra.length || stale.length ? 1 : 0);
}
