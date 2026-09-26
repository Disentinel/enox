// Enox compatibility (r_enox_compat): the MCP tools current Enox clients call,
// as rows of the operation table, over the SAME primitives — ask to read,
// signed batches to write. A client moves by changing its URL.
//
// The graph an Enox tool sees is a VIEW of facts (the ones r_import writes):
//   entity E   [E, enox:type|domain|label|description|source_ref|created_at|updated_at, v],
//              [E, enox:alias, a]… or [E, enox:aliases, <JSON list>] (update_node)
//   assertion  [S, rel, T] with its current confidence (conf 0 = deleted), and
//              [F, enox:asserted_by|context|proof_depth|created_at|updated_at|fact_id, v]
//              about it (F = its roflenox fact_id)
// Single-valued attributes resolve to the latest assertion in the chain.
// Updates and deletes are NEW assertions that supersede — the log stays
// append-only; a delete is the triple re-asserted with confidence 0.
//
// Reads run as the caller, inside what the caller may see. Writes run as the
// node's own identity (operator only), through normal admission.
import { createHash } from 'node:crypto';
import { factId, Refusal, type Fact } from './facts.ts';
import type { RoflenoxNode } from './node.ts';

const ENOX_PERSPECTIVE = 'enox';
const SINGLE = ['type', 'domain', 'label', 'description', 'source_ref', 'created_at', 'updated_at', 'aliases', 'content_type', 'body',
  'sha256', 'size', 'filename', 'artifact_id'];
const META = ['asserted_by', 'context', 'proof_depth', 'created_at', 'updated_at', 'fact_id', 'deleted_at'];
const STALE_TTL: Record<string, number> = { ml: 90, ai: 90, cs: 180, opinion: 365, memory: 180 };

/** Where this node mints entity ids. Neutral by default; a real node sets
 *  NODE_URI_PREFIX explicitly, and a mismatch with the ids it already holds
 *  is reported at startup (r_uri_prefix_stable). */
export const DEFAULT_URI_PREFIX = 'enox://example.org/graph/main';
export const uriPrefix = () => process.env.NODE_URI_PREFIX ?? DEFAULT_URI_PREFIX;

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return s || createHash('sha256').update(name).digest('hex').slice(0, 20);
}
export function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${sp > 0 ? cut.slice(0, sp) : cut}…`;
}
export function deriveDescription(text: string, max = 240): string {
  const t = text.trim();
  if (t === '') return '';
  return truncateAtWordBoundary(t.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 2).join(' '), max);
}
const enoxFactId = (s: string, r: string, t: string) => createHash('sha256').update(`${s}|${r}|${t}`).digest('hex');

export interface Node { id: string; type: string; domain: string; name: string; description: string; aliases: string[]; source_ref: string; created_at: string | null; updated_at: string | null; attrs: Map<string, string> }
export interface Edge { F: string; fact_id: string; source: string; target: string; relation: string; confidence: number; asserted_by: string | null; context: string; proof_depth: number; created_at: string | null; updated_at: string | null }

/** The Enox graph as `caller` may see it, built from asks. */
export class Graph {
  nodes = new Map<string, Node>();
  edges: Edge[] = [];

  static async load(node: RoflenoxNode, caller: string | null): Promise<Graph> {
    const g = new Graph();
    const facts = (await node.ask('edge(F, S, R, T)', caller)).rows as { cells: string[] }[];
    const seqRows = await node.ask('asserted(F, P, C, S)', caller).catch(() => ({ rows: [] }));
    const seq = new Map<string, number>();
    for (const r of seqRows.rows as { cells: [string, string, number, number] }[]) seq.set(r.cells[0], Math.max(seq.get(r.cells[0]) ?? -1, r.cells[3]));
    const conf = new Map<string, number>();
    for (const r of (await node.ask('conf(F, C)', caller)).rows as { cells: [string, number] }[]) conf.set(r.cells[0], r.cells[1]);
    // attribute (subject, attr) → [seq, value]; multi-valued aliases apart
    const single = new Map<string, [number, string]>();
    const aliases = new Map<string, string[]>();
    const assertions: { F: string; S: string; R: string; T: string }[] = [];
    for (const { cells: [F, S, R, T] } of facts) {
      if (R!.startsWith('enox:')) {
        const a = R!.slice(5);
        if (a === 'alias') { aliases.set(S!, [...(aliases.get(S!) ?? []), T!]); continue; }
        const key = `${S}\u0000${a}`;
        const s = seq.get(F!) ?? 0;
        const cur = single.get(key);
        if (!cur || s >= cur[0]) single.set(key, [s, T!]);
      } else if (!R!.startsWith('roflenox:')) {
        assertions.push({ F: F!, S: S!, R: R!, T: T! });
      }
    }
    const attr = (s: string, a: string) => single.get(`${s}\u0000${a}`)?.[1];
    const subjects = new Set<string>();
    for (const k of single.keys()) { const [s, a] = k.split('\u0000'); if (a === 'label' || a === 'type') subjects.add(s!); }
    for (const id of subjects) {
      const listed = attr(id, 'aliases');
      g.nodes.set(id, {
        id, type: attr(id, 'type') ?? 'concept', domain: attr(id, 'domain') ?? '', name: attr(id, 'label') ?? '',
        description: attr(id, 'description') ?? '', aliases: listed !== undefined ? JSON.parse(listed) as string[] : [...new Set(aliases.get(id) ?? [])].sort(),
        source_ref: attr(id, 'source_ref') ?? '', created_at: attr(id, 'created_at') ?? null, updated_at: attr(id, 'updated_at') ?? null,
        attrs: new Map(SINGLE.map((a) => [a, attr(id, a)]).filter(([, v]) => v !== undefined) as [string, string][]),
      });
    }
    for (const a of assertions) {
      const c = conf.get(a.F);
      if (c === undefined || c === 0) continue;                        // deleted (or not visible)
      if (!g.nodes.has(a.S) || !g.nodes.has(a.T)) continue;
      g.edges.push({
        F: a.F, fact_id: attr(a.F, 'fact_id') ?? enoxFactId(a.S, a.R, a.T), source: a.S, target: a.T, relation: a.R,
        confidence: c / 1000, asserted_by: attr(a.F, 'asserted_by') ?? null, context: attr(a.F, 'context') ?? '',
        proof_depth: Number(attr(a.F, 'proof_depth') ?? 0), created_at: attr(a.F, 'created_at') ?? null, updated_at: attr(a.F, 'updated_at') ?? null,
      });
    }
    return g;
  }

  record(n: Node) {
    return { id: n.id, type: n.type, domain: n.domain, name: n.name, description: n.description, aliases: n.aliases, source_ref: n.source_ref,
      created_at: n.created_at, updated_at: n.updated_at };
  }

  row(e: Edge) {
    const s = this.nodes.get(e.source)!, t = this.nodes.get(e.target)!;
    return { fact_id: e.fact_id, source: e.source, source_name: s.name, source_type: s.type, target: e.target, target_name: t.name, target_type: t.type,
      relation: e.relation, asserted_by: e.asserted_by, confidence: e.confidence, context: e.context, created_at: e.created_at, updated_at: e.updated_at };
  }

  /** Enox's resolveNode: exact id, then name (case-insensitive), then name contains. */
  resolve(term: string): Node | null {
    if (this.nodes.has(term)) return this.nodes.get(term)!;
    const lt = term.toLowerCase();
    const all = [...this.nodes.values()];
    return all.find((n) => n.name.toLowerCase() === lt) ?? all.find((n) => n.name.toLowerCase().includes(lt)) ?? null;
  }

  out(id: string) { return this.edges.filter((e) => e.source === id); }
  in(id: string) { return this.edges.filter((e) => e.target === id); }
}

// --------------------------------------------------------------------------
// Writes: facts for one tool call, published as the node's identity.

const now = () => new Date().toISOString();

function entityFacts(id: string, name: string, type: string, domain: string, description: string, t: string): Fact[] {
  return [['type', type], ['domain', domain], ['label', name], ['description', description], ['created_at', t], ['updated_at', t]]
    .filter(([, v]) => v !== '').map(([a, v]) => ({ source: id, relation: `enox:${a}`, target: v!, perspective: ENOX_PERSPECTIVE, confidence: 1 }));
}

const meta = (F: string, a: string, v: string | number): Fact => ({ source: F, relation: `enox:${a}`, target: String(v), perspective: ENOX_PERSPECTIVE, confidence: 1 });

/** One batch of facts, each triple once (the first wins). */
function uniq(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter((f) => { const k = factId(f); if (seen.has(k)) return false; seen.add(k); return true; });
}

export interface AddArgs {
  source: string; target: string; relation: string; source_type?: string; source_domain?: string; target_type?: string; target_domain?: string;
  confidence?: number; context?: string; asserted_by?: string; proof_depth?: number;
}

/** add_assertion's resolution and facts (shared with batch_assertions). */
export function addFacts(g: Graph, a: AddArgs, agent: string, created: Map<string, Node>) {
  const t = now();
  const facts: Fact[] = [];
  const res = (name: string, type: string, domain: string) => {
    const found = g.nodes.get(name) ?? created.get(name) ?? [...g.nodes.values(), ...created.values()].find((n) => n.name === name);
    if (found) return found.id;
    const id = `${uriPrefix()}/${domain}/${slugify(name)}`;
    const desc = deriveDescription(a.context ?? '');
    facts.push(...entityFacts(id, name, type, domain, desc, t));
    created.set(name, { id, type, domain, name, description: desc, aliases: [], source_ref: '', created_at: t, updated_at: t, attrs: new Map() });
    return id;
  };
  const sid = res(a.source, a.source_type ?? 'concept', a.source_domain ?? 'cs');
  const tid = res(a.target, a.target_type ?? 'concept', a.target_domain ?? 'cs');
  const fid = enoxFactId(sid, a.relation, tid);
  const existing = g.edges.find((e) => e.fact_id === fid);
  const F = factId({ source: sid, relation: a.relation, target: tid });
  const confidence = a.confidence ?? 1;
  const by = a.asserted_by ?? agent;
  facts.push({ source: sid, relation: a.relation, target: tid, perspective: ENOX_PERSPECTIVE, confidence },
    meta(F, 'asserted_by', by), meta(F, 'fact_id', fid), meta(F, 'updated_at', t));
  if (a.context) facts.push(meta(F, 'context', a.context));
  if (!existing) facts.push(meta(F, 'created_at', t), meta(F, 'proof_depth', a.proof_depth ?? 0));
  const result = { fact_id: fid, source: sid, target: tid, relation: a.relation, asserted_by: by, confidence,
    proof_depth: existing ? existing.proof_depth : a.proof_depth ?? 0, context: a.context ?? '', created: !existing, updated: !!existing };
  return { facts, result, inverse: g.edges.find((e) => e.source === tid && e.target === sid && e.relation === a.relation) };
}

export { enoxFactId, meta, entityFacts, uniq, ENOX_PERSPECTIVE, STALE_TTL, META };

export function refuseText(text: string): Refusal {
  return new Refusal(404, 'enox_error', text, { plain: true });
}
