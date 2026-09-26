// EXPIRY, judged at decision time (r_grants, r_agents_as_identities).
//
// REPLACES the clock premise `clock[sys](T), T < U` in the may_read and
// delegated rules (engine.bookRules until 2026-09-27). With a clock fact in
// the main world, every new second re-derived every fact (rofl-serve has no
// incremental evaluate). The rules now carry the expiry as a column
// (readable_until, delegated_until); the node compares it with its clock.
//
// A REFUSAL is still explained by the engine, with the original rule: a
// small throwaway world holds just the facts that rule reads, the rule with
// its clock premise, and the clock — so the whynot names the missing grant
// or the failed `T < U` exactly as before. This is the WORKAROUND's seam:
// with an incremental engine the clock premise returns to bookRules.
import { roflString } from './facts.ts';
import { SYSTEM_BOOK, type Engine } from './engine.ts';

const S = SYSTEM_BOOK;

/** The engine's whynot of may_read(reader, book) at `sec`. */
export async function whyNotReadable(engine: Engine, reader: string, book: string, owner: string, sec: number): Promise<string> {
  const grants = await engine.sysRows(`grant[${book}](R, U)`).catch(() => []);
  const facts = grants.map(([r, u]) => `grant[${book}](${roflString(String(r))}, ${u}).`).join('\n');
  const rules = `may_read[${S}](${roflString(owner)}, ${roflString(book)}).\n`
    + `may_read[${S}](R, ${roflString(book)}) :- grant[${book}](R, U), clock[${S}](T), T < U.\n`;
  return engine.explainAlone(`${facts}\n${rules}clock[${S}](${sec}).\n`, `may_read[${S}](${roflString(reader)}, ${roflString(book)})`);
}

/** The engine's whynot of delegated(agent, parent) at `sec`. */
export async function whyNotDelegated(engine: Engine, agent: string, parent: string, parentBook: string, sec: number): Promise<string> {
  const rows = await engine.sysRows(`delegate[${parentBook}](A, U)`).catch(() => []);
  const facts = rows.map(([a, u]) => `delegate[${parentBook}](${roflString(String(a))}, ${u}).`).join('\n');
  const rule = `delegated[${S}](A, ${roflString(parent)}) :- delegate[${parentBook}](A, U), clock[${S}](T), T < U.\n`;
  return engine.explainAlone(`${facts}\n${rule}clock[${S}](${sec}).\n`, `delegated[${S}](${roflString(agent)}, ${roflString(parent)})`);
}
