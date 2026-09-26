// A deterministic fake executor: no model, no deps. It answers each intent
// addressed to it with the SHA-256 of its input, burning CPU for a while per
// intent; with BURN=1 it then keeps burning until the kernel stops it.
import * as crypto from 'node:crypto';
import { LocalIdentity } from '../../src/identity.ts';
import { publishResults, pullIntents } from '../../src/executor.ts';

const url = process.env.ROFLENOX_URL!;
const me = LocalIdentity.load(process.env.ROFLENOX_DATA!)!;
const burn = (ms: number) => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x = (x * 31 + 7) % 1_000_003; return x; };

const intents = await pullIntents(url, me);
const results = intents.map((i) => {
  burn(100);
  return { key: i.key, value: crypto.createHash('sha256').update(String(i.input)).digest('hex') };
});
await publishResults(url, me, results);
process.stdout.write(`answered ${results.length}\n`);
if (process.env.BURN === '1') for (;;) burn(1000);   // saturate the CPU budget until SIGXCPU
