// RFC 8785 and the derived ids. Expected values are hard-coded from outside
// this code: the RFC's own text, and `printf ... | shasum -a 256`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/jcs.ts';
import { batchDigest, factId, parseJsonl, sha256hex, toJsonl } from '../src/facts.ts';

test('fact_id equals SHA-256 of the RFC 8785 serialisation of [source, relation, target] for a fixed vector', () => {
  // printf '%s' '["alice","knows","bob"]' | shasum -a 256
  assert.equal(factId({ source: 'alice', relation: 'knows', target: 'bob' }),
    '96fcbfdb97e95ca0298248fdad6ac71832c6dcc1cf83ca85d946acaa4e3ed8bc');
  // python3: json.dumps(v, ensure_ascii=False, separators=(",",":")) | sha256
  assert.equal(factId({ source: 'Straße', relation: '→ «ok»', target: '😀' }),
    '228e9a9995eb0aaf6ba9134a5f9f06756a22cb8de34ea02665884e1cc3dfbc90');
  // Perspective and confidence are not part of the fact's identity.
  const [x] = parseJsonl(toJsonl([{ source: 'alice', relation: 'knows', target: 'bob', perspective: 'p', confidence: 0.1 }]));
  assert.equal(factId(x!), '96fcbfdb97e95ca0298248fdad6ac71832c6dcc1cf83ca85d946acaa4e3ed8bc');
});

test('RFC 8785 section 3.2.2: the example object canonicalises exactly', () => {
  const input = '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],'
    + ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}';
  assert.equal(canonicalize(JSON.parse(input)),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
    + '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
});

test('RFC 8785 section 3.2.3: members sort by UTF-16 code units', () => {
  const o = {
    '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One',
    '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis',
  };
  const keys = Object.keys(JSON.parse(canonicalize(o)));
  // Object.keys puts integer-like keys first, so compare the serialised order instead.
  const order = [...canonicalize(o).matchAll(/"([^"]*)":"([^"]*)"/g)].map((m) => m[2]);
  assert.deepEqual(order, ['Carriage Return', 'One', 'Control', 'Latin Small Letter O With Diaeresis',
    'Euro Sign', 'Emoji: Grinning Face', 'Hebrew Letter Dalet With Dagesh']);
  assert.equal(keys.length, 7);
});

test('RFC 8785 appendix B: number serialisation vectors', () => {
  const f64 = (hex: string) => Buffer.from(hex, 'hex').readDoubleBE(0);
  const vectors: [string, string][] = [
    ['0000000000000000', '0'], ['8000000000000000', '0'], ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'], ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'], ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'], ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'], ['44b52d02c7e14af6', '1e+23'],
    ['3eb0c6f7a0b5ed8d', '0.000001'], ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ];
  for (const [hex, want] of vectors) assert.equal(canonicalize(f64(hex)), want, hex);
  for (const hex of ['7fffffffffffffff', '7ff0000000000000']) assert.throws(() => canonicalize(f64(hex)));
  assert.throws(() => canonicalize('\ud800'), /well-formed/);
});

test('batch digest is SHA-256 of the salt followed by the JSONL bytes', () => {
  const jsonl = toJsonl([{ source: 'alice', relation: 'knows', target: 'bob', perspective: 'p', confidence: 1 }]);
  assert.equal(jsonl, '{"confidence":1,"perspective":"p","relation":"knows","source":"alice","target":"bob"}\n');
  // python3: salt = bytes(range(1, 33)); sha256(salt + jsonl)
  const salt = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';
  assert.equal(batchDigest(salt, jsonl), '1a2f593ee8de4cb3cb0d0de9fe57c4f18a846f11e5a544cd26cf5e2697c12606');
  // printf '%s\n' '<the line>' | shasum -a 256 — the unsalted digest, which a withheld manifest must NOT equal
  assert.notEqual(batchDigest(salt, jsonl), sha256hex(jsonl));
  assert.equal(sha256hex(jsonl), 'd7b55f78f251e7333b69e848db0efe3132d45f4dc3eb5112cbd937a6a5e0d17c');
});
