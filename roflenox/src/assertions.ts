// THE CURRENT ASSERTION OF EACH FACT, kept by admission (r_confidence,
// r_perspective, r_batch_write).
//
// REPLACES the rules `superseded[sys]`, `current[sys]` and `view[sys]`
// (engine.bookRules until 2026-09-27): a self-join of every assertion, a
// negation over it, and a 200 000-row join — 6.7 of the 8.5 s a full
// evaluate took at 200 000 facts. This is a WORKAROUND for a non-incremental
// engine (rofl-serve re-derives everything on each evaluate); with an
// incremental evaluate this family goes back into rules.
//
// What it does instead: an identity's later assertion of a fact (later in its
// chain) replaces the earlier one. Admission knows the chain order and keeps
// the current assertion of each fact HERE; asserted(F, P, C, S), conf(F, C)
// and persp(F, P) are answered from it (node.askAssertions), and why/whynot
// explain from it too. The main world holds no asserted rows: rofl-serve's
// retract took 0.15–20 s per row at 200 000 facts (measured 2026-09-28), so
// an update or delete, each replacing one assertion, took seconds
// (r_compat_parity). Only the rows a fact's current assertion ACTS through —
// a grant, delegation, export, trust or follow — are loaded into, and
// retracted from, the main world; a rule world loads the asserted rows whole.
// The log keeps every assertion; replay loads only the current.
import { DELEGATE, EXPORT, factId, GRANT, permille, roflString, sha256hex, type Fact } from './facts.ts';
import { checkName } from './identity.ts';

export interface Current { P: string; C: number; S: number; follow?: string; ctl?: string }

/** A CONTROL fact's engine row (r_confidence): grant[book](R, Until),
 *  delegate[book](Agent, Until), export[book](Rel, Audience). One row per
 *  fact, present only while the fact's current confidence is above 0 —
 *  re-asserting it at 0 retires it, and with it the access, delegation or
 *  publication it granted. (Rules and trust are filtered the same way where
 *  they are used; a follow keeps its own row below.) */
function controlRow(book: string, f: Fact): string | undefined {
  const until = () => Math.floor(Date.parse(f.target) / 1000);
  // Names in control rows are canonical (r_identity_names): a grant to
  // "Bob" acts for bob, and a name that is none refuses the batch.
  const name = (x: string) => roflString(checkName(x));
  if (f.relation === GRANT) return `grant[${book}](${name(f.source)}, ${until()})`;
  if (f.relation === DELEGATE) return `delegate[${book}](${name(f.source)}, ${until()})`;
  if (f.relation === EXPORT) return `export[${book}](${roflString(f.source)}, ${f.target === 'public' ? '"public"' : name(f.target)})`;
  if (f.relation === TRUST) return `trusts[${book}](${name(f.source)})`;
  return undefined;
}
const TRUST = 'roflenox:trust_rules';
const acting = (c: Current | undefined): c is Current & { ctl: string } => c?.ctl !== undefined && c.C > 0;

/** A follow is a CURRENT assertion too: `follows[book](Name, b_<atom>)` — the
 *  row a rule ranges over books by — exists only while the follow's current
 *  confidence is above 0. Retiring it (confidence 0) retracts the row, so
 *  every rule ranging over that host's book stops (r_uc_observability). */
const FOLLOW = 'roflenox:follow';

export class Assertions {
  private readonly by = new Map<string, Map<string, Current>>();

  of(identity: string): Map<string, Current> {
    let m = this.by.get(identity);
    if (!m) { m = new Map(); this.by.set(identity, m); }
    return m;
  }

  /** What a batch changes, without changing anything yet: the engine rows it
   *  replaces (to retract), the rows to load, and `apply` to record it once
   *  the batch is admitted. */
  plan(identity: string, book: string, facts: Fact[], seq: number): { retract: string[]; load: string; apply: () => void } {
    const m = this.of(identity);
    const retract: string[] = [];
    const load: string[] = [];
    const next = new Map<string, Current>();
    const unfollowed = new Set<string>();
    for (const f of facts) {
      const F = factId(f);
      const old = next.get(F) ?? m.get(F);
      if (old && old.S > seq) continue;                 // never happens in chain order; guard anyway
      if (old && !next.has(F) && old.follow !== undefined && old.C > 0) unfollowed.add(old.follow);
      const ctl = controlRow(book, f);
      const cur: Current = { P: f.perspective, C: permille(f.confidence), S: seq, ...(f.relation === FOLLOW ? { follow: f.source } : {}), ...(ctl ? { ctl } : {}) };
      next.set(F, cur);
      if (cur.follow !== undefined && cur.C > 0) load.push(`${followRow(book, cur.follow)}.`);
    }
    // A control row changes only when the fact starts or stops acting: loaded
    // and retracted rows are applied load-then-retract, so a row that stays
    // is touched by neither.
    for (const [F, cur] of next) {
      const was = m.get(F);
      if (acting(cur) && !acting(was)) load.push(`${cur.ctl}.`);
      if (acting(was) && !acting(cur)) retract.push(was.ctl);
    }
    // A follows row goes only when NO current follow of that name is left:
    // two follow facts of one host with one retired still follow it, and a
    // re-asserted follow keeps the row (admission loads, then retracts).
    // (Only a batch that retires a follow pays for the scan.)
    for (const name of unfollowed) {
      const still = (F: string, c: Current) => c.follow === name && c.C > 0 && (next.get(F) ?? c) === c;
      if (![...next].some(([F, c]) => still(F, c)) && ![...m].some(([F, c]) => !next.has(F) && still(F, c))) retract.push(followRow(book, name));
    }
    return { retract, load: load.length ? `${load.join('\n')}\n` : '', apply: () => { for (const [F, c] of next) m.set(F, c); } };
  }

  /** Every current assertion of an identity, as ROFL: its control and follow
   *  rows (the main world), and with `asserted` its asserted rows too (rule
   *  worlds, where an author's rules may read them). */
  lines(identity: string, book: string, asserted = false): string {
    const m = this.by.get(identity);
    if (!m) return '';
    return [...m].map(([F, c]) => `${asserted ? `${row(book, F, c)}.\n` : ''}${c.follow !== undefined && c.C > 0 ? `${followRow(book, c.follow)}.\n` : ''}${acting(c) ? `${c.ctl}.\n` : ''}`).join('');
  }
}

const followRow = (book: string, name: string) => `follows[${book}](${roflString(checkName(name))}, b_${sha256hex(checkName(name)).slice(0, 16)})`;
const row = (book: string, F: string, c: Current) => `asserted[${book}](${roflString(F)}, ${roflString(c.P)}, ${c.C}, ${c.S})`;

/** Match literal arguments (ROFL terms) against a row of values: variables
 *  bind (a repeated one must agree), `_` matches anything, constants compare.
 *  Returns the bound columns in first-appearance order, or null. */
export function match(args: string[], values: (string | number)[]): { vars: string[]; cells: (string | number)[] } | null {
  const bound = new Map<string, string | number>();
  const vars: string[] = [];
  const cells: (string | number)[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.trim();
    const v = values[i]!;
    if (a === '_') { vars.push('_'); cells.push(v); continue; }
    if (/^[A-Z_]/.test(a)) {
      if (bound.has(a)) { if (bound.get(a) !== v) return null; continue; }
      bound.set(a, v); vars.push(a); cells.push(v);
      continue;
    }
    const c = a.startsWith('"') ? JSON.parse(a) as string : /^-?\d+$/.test(a) ? Number(a) : a;
    if (c !== v) return null;
  }
  return { vars, cells };
}
