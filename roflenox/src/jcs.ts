// RFC 8785 JSON Canonicalization Scheme.
//
// The RFC defines JCS in terms of ECMAScript's own serialisation: strings as
// JSON.stringify writes them, numbers as Number.prototype.toString writes them,
// object members sorted by their names' UTF-16 code units. So the canonicaliser
// is small, and the only work is refusing what I-JSON forbids: non-finite
// numbers and strings that are not well-formed Unicode (lone surrogates).

export class JcsError extends Error {}

function str(s: string): string {
  if (!s.isWellFormed()) throw new JcsError('string is not well-formed Unicode (lone surrogate)');
  return JSON.stringify(s);
}

// Sorting by UTF-16 code units is JavaScript's default string comparison.
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new JcsError(`number is not finite: ${v}`);
      return JSON.stringify(v); // -0 serialises as 0, as the RFC requires
    case 'string': return str(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(byCodeUnits);
      return `{${keys.map((k) => `${str(k)}:${canonicalize(o[k])}`).join(',')}}`;
    }
    default:
      throw new JcsError(`not representable in JSON: ${typeof v}`);
  }
}
