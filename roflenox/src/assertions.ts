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

/** A fact's current assertion: perspective, confidence (permille), chain
 *  position, and N — the order the node received it in, over all facts. A
 *  control fact carries its engine row (ctl) and whether that row is loaded
 *  (on); a grant, its grantee (r_live_view). */
export interface Current { P: string; C: number; S: number; N: number; /** The chain position of the identity's first assertion of the fact. */ first: number;
  /** In a family view (RoflenoxNode.view): whose assertion this is, when not the book's own. */ by?: string; follow?: string; ctl?: string; on?: boolean; grantee?: string }

/** Relations that hold one value per subject (r_live_view): an entity's
 *  attributes and an edge's (src/enox.ts). The latest assertion above
 *  confidence 0 is the value; the others stay history. */
const ONE_VALUE = new Set(['type', 'domain', 'label', 'description', 'source_ref', 'created_at', 'updated_at', 'aliases', 'content_type', 'body',
  'sha256', 'size', 'filename', 'artifact_id', 'asserted_by', 'context', 'proof_depth', 'fact_id', 'deleted_at'].map((a) => `enox:${a}`));
export const oneValue = (R: string) => ONE_VALUE.has(R);
/** An identity's assertions, now or as they stood at an earlier head. */
export interface View { get(F: string): Current | undefined; [Symbol.iterator](): Iterator<[string, Current]> }

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
const acting = (c: Current | undefined): c is Current & { ctl: string } => c?.ctl !== undefined && c.on === true;

/** A follow is a CURRENT assertion too: `follows[book](Name, b_<atom>)` — the
 *  row a rule ranges over books by — exists only while the follow's current
 *  confidence is above 0. Retiring it (confidence 0) retracts the row, so
 *  every rule ranging over that host's book stops (r_uc_observability). */
const FOLLOW = 'roflenox:follow';

export class Assertions {
  private readonly by = new Map<string, Map<string, Current>>();
  /** Per identity: subject → one-value relation → the facts that set it, and
   *  grantee → its grant facts, each in first-seen order. */
  private readonly values = new Map<string, Map<string, Map<string, string[]>>>();
  private readonly grants = new Map<string, Map<string, string[]>>();
  private received = 0;

  of(identity: string): Map<string, Current> {
    let m = this.by.get(identity);
    if (!m) { m = new Map(); this.by.set(identity, m); }
    return m;
  }

  /** The fact that holds the value of a one-value relation of `S` now — or
   *  in `view`, an earlier state (r_ask_at_revision): the latest received
   *  above confidence 0 (r_live_view). */
  valueOf(identity: string, S: string, R: string, view: View = this.of(identity)): string | undefined {
    return this.valueAcross([[identity, view]], S, R);
  }

  /** The same across several books seen together — the owner's and its
   *  sessions' (r_session_identity): the latest received above 0 of any. */
  valueAcross(books: [string, View][], S: string, R: string): string | undefined {
    let best: [number, string] | undefined;
    for (const [identity, view] of books) {
      for (const F of this.values.get(identity)?.get(S)?.get(R) ?? []) {
        const c = view.get(F);
        if (c && c.C > 0 && (!best || c.N > best[0])) best = [c.N, F];
      }
    }
    return best?.[1];
  }

  /** Is this fact live (r_live_view): asserted above confidence 0 now (or in
   *  `view`), and — for a one-value relation — the value; for a grant, the
   *  one in force. */
  live(identity: string, F: string, S: string, R: string, view: View = this.of(identity)): boolean {
    const c = view.get(F);
    if (!c || c.C <= 0) return false;
    if (c.grantee !== undefined) return c.on === true;
    return !oneValue(R) || this.valueOf(identity, S, R, view) === F;
  }

  /** An identity's assertions as they stood before the batches `undo` names
   *  undid them (r_ask_at_revision): `undo` maps each fact a later batch
   *  touched to its assertion before that — null where it had none. */
  viewAt(identity: string, undo: Map<string, Current | null> | undefined): View {
    const m = this.of(identity);
    if (!undo || undo.size === 0) return m;
    return {
      get: (F) => { const o = undo.get(F); return o === undefined ? m.get(F) : o ?? undefined; },
      *[Symbol.iterator]() {
        for (const [F, c] of m) { const o = undo.get(F); if (o === undefined) yield [F, c]; else if (o !== null) yield [F, o]; }
      },
    };
  }

  /** What a batch changes, without changing anything yet: the engine rows it
   *  replaces (to retract), the rows to load, and `apply` to record it once
   *  the batch is admitted. */
  plan(identity: string, book: string, facts: Fact[], seq: number): { retract: string[]; load: string; before: Map<string, Current | null>; apply: () => void } {
    const m = this.of(identity);
    const retract: string[] = [];
    const load: string[] = [];
    const next = new Map<string, Current>();
    const unfollowed = new Set<string>();
    const firsts: { F: string; f: Fact }[] = [];
    const granted = new Map<string, string[]>();      // grantee → grant facts new to this identity
    for (const f of facts) {
      const F = factId(f);
      const old = next.get(F) ?? m.get(F);
      if (old && old.S > seq) continue;                 // never happens in chain order; guard anyway
      if (old && !next.has(F) && old.follow !== undefined && old.C > 0) unfollowed.add(old.follow);
      const ctl = controlRow(book, f);
      const cur: Current = { P: f.perspective, C: permille(f.confidence), S: seq, N: ++this.received, first: old?.first ?? seq, ...(f.relation === FOLLOW ? { follow: f.source } : {}),
        ...(ctl ? { ctl } : {}), ...(f.relation === GRANT ? { grantee: checkName(f.source) } : {}) };
      if (!m.has(F) && !next.has(F)) {
        firsts.push({ F, f });
        if (cur.grantee !== undefined) granted.set(cur.grantee, [...(granted.get(cur.grantee) ?? []), F]);
      }
      next.set(F, cur);
      if (cur.follow !== undefined && cur.C > 0) load.push(`${followRow(book, cur.follow)}.`);
    }
    // Which control rows act after this batch: a control fact's while its
    // current assertion is above 0 — and a grant's only while it is the
    // grantee's latest grant (r_live_view): a newer grant to the same grantee
    // replaces it, and retiring the newest leaves none in force (an older
    // grant never comes back). A row changes only when its fact starts or
    // stops acting, and a row both loaded and retracted is touched by neither.
    const on = new Map<string, boolean>();
    for (const [F, cur] of next) if (cur.ctl !== undefined && cur.grantee === undefined) on.set(F, cur.C > 0);
    const grantees = new Set([...next.values()].map((c) => c.grantee).filter((g): g is string => g !== undefined));
    const held = this.grants.get(identity);
    for (const g of grantees) {
      const Fs = [...(held?.get(g) ?? []), ...(granted.get(g) ?? [])];
      let latest: [number, string] | undefined;
      for (const F of Fs) { const c = next.get(F) ?? m.get(F)!; if (!latest || c.N > latest[0]) latest = [c.N, F]; }
      for (const F of Fs) on.set(F, F === latest![1] && (next.get(F) ?? m.get(F)!).C > 0);
    }
    const loads = new Set<string>(), retracts = new Set<string>();
    for (const [F, act] of on) {
      const was = acting(m.get(F));
      const ctl = (next.get(F) ?? m.get(F)!).ctl!;
      if (act && !was) loads.add(ctl);
      if (!act && was) retracts.add(m.get(F)!.ctl!);
    }
    for (const r of loads) if (retracts.has(r)) { loads.delete(r); retracts.delete(r); }
    for (const r of loads) load.push(`${r}.`);
    retract.push(...retracts);
    // A follows row goes only when NO current follow of that name is left:
    // two follow facts of one host with one retired still follow it, and a
    // re-asserted follow keeps the row (admission loads, then retracts).
    // (Only a batch that retires a follow pays for the scan.)
    for (const name of unfollowed) {
      const still = (F: string, c: Current) => c.follow === name && c.C > 0 && (next.get(F) ?? c) === c;
      if (![...next].some(([F, c]) => still(F, c)) && ![...m].some(([F, c]) => !next.has(F) && still(F, c))) retract.push(followRow(book, name));
    }
    // What each fact this batch changes was before it (r_ask_at_revision).
    const before = new Map<string, Current | null>();
    for (const F of [...next.keys(), ...on.keys()]) { const c = m.get(F); before.set(F, c ? { ...c } : null); }
    return { retract, load: load.length ? `${load.join('\n')}\n` : '', before, apply: () => {
      for (const [F, c] of next) m.set(F, c);
      for (const [F, act] of on) m.get(F)!.on = act;
      for (const { F, f } of firsts) this.index(identity, F, f);
    } };
  }

  private index(identity: string, F: string, f: Fact): void {
    if (f.relation === GRANT) {
      const g = this.grants.get(identity) ?? new Map<string, string[]>();
      this.grants.set(identity, g);
      const k = checkName(f.source);
      g.set(k, [...(g.get(k) ?? []), F]);
    } else if (oneValue(f.relation)) {
      const v = this.values.get(identity) ?? new Map<string, Map<string, string[]>>();
      this.values.set(identity, v);
      const byR = v.get(f.source) ?? new Map<string, string[]>();
      v.set(f.source, byR);
      const Fs = byR.get(f.relation);
      if (Fs) Fs.push(F); else byR.set(f.relation, [F]);
    }
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
