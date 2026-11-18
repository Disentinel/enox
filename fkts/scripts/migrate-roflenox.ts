// Copy a node written before the rename into a fresh FKTS data directory,
// every batch signed again (scripts/migrate.ts says what changes and what is kept):
//
//   npm run migrate:roflenox -- OLD NEW [--also OLD2=NEW2]...
//
// OLD (e.g. ~/.roflenox) is only read and may stay running; NEW (e.g. ~/.fkts)
// must not exist. --also names another identity's data directory whose key
// signed batches in OLD (an executor such as the embedder) and where its key
// file is to be written for FKTS. Prints what was written, and the new node's
// health to compare with the old one's.
import { migrate } from './migrate.ts';

const args = process.argv.slice(2);
const also: { from: string; to: string }[] = [];
const pos: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--also') {
    const [from, to] = (args[++i] ?? '').split('=');
    if (!from || !to) { console.error('--also OLD_DIR=NEW_DIR'); process.exit(2); }
    also.push({ from, to });
  } else pos.push(args[i]!);
}
if (pos.length !== 2) { console.error('usage: migrate-roflenox OLD NEW [--also OLD2=NEW2]...'); process.exit(2); }
try {
  const r = await migrate(pos[0]!, pos[1]!, also);
  console.log(JSON.stringify(r, null, 1));
} catch (e) {
  console.error(`migrate: ${(e as Error).message}`);
  process.exit(1);
}
