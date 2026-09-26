// Child process for the crash tests: admit one batch with a fault hook that
// SIGKILLs this process at the named point of the write. Not a test file.
import * as fs from 'node:fs';
import { RoflenoxNode } from '../src/node.ts';

const [dir, point, bodyPath, t] = process.argv.slice(2) as [string, string, string, string];
const node = await RoflenoxNode.open({
  dataDir: dir,
  now: () => Number(t),
  fault: (p) => { if (p === point) process.kill(process.pid, 'SIGKILL'); },
});
await node.admit(JSON.parse(fs.readFileSync(bodyPath, 'utf8')));
process.stdout.write('survived\n');
await node.close();
