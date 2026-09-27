// node:test as the lister sees it: test() and it() record their name and run
// nothing; describe() runs its body at once, so the tests inside it record too.
// A subtest (t.test) lives inside a test body, which never runs: it is not listed.
import * as real from 'node:test';

const seen = (globalThis.__testList ??= []);
export function test(name) { seen.push(typeof name === 'string' ? name : `<not a string: ${typeof name}>`); }
test.skip = test.only = test.todo = test;
export const it = test;
export function describe(name, opts, fn) { (typeof opts === 'function' ? opts : fn)?.(); }
describe.skip = describe.only = describe.todo = describe;
export const suite = describe;
export const { before, after, beforeEach, afterEach, mock, run } = real;
export default test;
