// A deterministic fake executor for the read-path test: no model, no deps.
// It embeds each intent as the SHA-256 of its text, burning CPU for a while
// per intent, then keeps burning until the kernel stops it at its CPU budget.
import * as crypto from 'node:crypto';
import { LocalIdentity } from '../../src/identity.ts';
import { publishEmbeddings, pullIntents } from '../../src/executor.ts';

const url = process.env.ROFLENOX_URL!;
const me = LocalIdentity.load(process.env.ROFLENOX_DATA!)!;
const burn = (ms: number) => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x = (x * 31 + 7) % 1_000_003; return x; };

const intents = await pullIntents(url, me, 'needs_embedding');
const results = intents.map((i) => {
  burn(100);
  return { fact_id: i.fact_id, value: crypto.createHash('sha256').update(i.text).digest('hex') };
});
await publishEmbeddings(url, me, results);
process.stdout.write(`embedded ${results.length}\n`);
for (;;) burn(1000);                              // saturate the CPU budget until SIGXCPU
