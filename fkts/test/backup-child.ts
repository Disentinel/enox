// Child process for the backup crash test: back up <dir> into <to> with a
// fault hook that SIGKILLs this process at the named step. Not a test file.
import { backup } from '../src/backup.ts';

const [dir, to, point, t] = process.argv.slice(2) as [string, string, string, string];
await backup(dir, to, { now: () => Number(t), fault: (p) => { if (p === point) process.kill(process.pid, 'SIGKILL'); } });
process.stdout.write('survived\n');
