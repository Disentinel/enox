// Enox compatibility (r_enox_compat): the MCP tools current Enox clients call,
// as rows of the operation table, over the SAME primitives — ask to read,
// signed batches to write. A client moves by changing its URL.
//
// The graph an Enox tool sees is a VIEW of facts (the ones r_import writes):
//   entity E   [E, enox:type|domain|label|description|source_ref|created_at|updated_at, v],
//              [E, enox:alias, a]… or [E, enox:aliases, <JSON list>] (update_node)
//   assertion  [S, rel, T] with its current confidence (conf 0 = deleted), and
//              [F, enox:asserted_by|context|proof_depth|created_at|updated_at|fact_id, v]
//              about it (F = its roflenox fact_id). An edge reads back asserted
//              by the identities whose signed batches hold it (r_asserted_by);
//              an enox:asserted_by a batch writes is its claim: shown beside
//              the signer as claimed_by (r_enox_compat), never as who asserted.
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
export interface Edge { /** The fact id ask returns: F of edge(F, S, R, T). */ F: string; /** The Enox fact_id. */ fact_id: string; source: string; target: string; relation: string; confidence: number; asserted_by: string | null; claimed_by: string | null; context: string; proof_depth: number; created_at: string | null; updated_at: string | null;
  /** When it was last written: the log position of the latest batch holding
   *  the assertion or a fact about it (RoflenoxNode.writtenAt). */
  written: number }

/** The Enox graph as `caller` may see it, built from asks. */
export class Graph {
  nodes = new Map<string, Node>();
  // The raw state the view is derived from: every visible fact, its current
  // confidence (permille) and chain position. Kept so a write is APPLIED
  // (r_enox_compat, r_batch_write) instead of rebuilding the view from asks —
  // 8.3 s at 200 000 facts. And applied INCREMENTALLY (r_compat_parity): a
  // write re-derives only the entities and assertions it touches — a full
  // re-derivation took ~1.5 s per write at 200 000 facts.
  private readonly raw = new Map<string, { S: string; R: string; T: string }>();
  private readonly conf = new Map<string, number>();
  private readonly seq = new Map<string, number>();
  /** Where in the log each fact was last asserted (r_recent_order). */
  private readonly written = new Map<string, number>();
  private orderOf: (identity: string, seq: number) => number = () => -1;
  /** Who signed each fact: the identities whose books hold it. */
  private readonly by = new Map<string, Set<string>>();
  /** First-seen order of each fact: the order a full derivation walks them. */
  private readonly rank = new Map<string, number>();
  /** subject → attribute → the facts that set it (in first-seen order), and
   *  subject → its alias facts. Retired ones are skipped when resolving. */
  private readonly attrFacts = new Map<string, Map<string, string[]>>();
  /** Every assertion fact (not enox:/roflenox:), and those touching an entity. */
  private readonly assertionIds = new Set<string>();
  private readonly touching = new Map<string, Set<string>>();
  /** The derived view: edges by fact, and their adjacency. */
  private readonly edgeOf = new Map<string, Edge>();
  private readonly outOf = new Map<string, Set<string>>();
  private readonly inOf = new Map<string, Set<string>>();
  private readonly byFactId = new Map<string, Set<string>>();
  /** Every Enox fact_id a fact about an assertion names (enox:fact_id), live
   *  or deleted → the assertions it names (r_one_fact_id). */
  private readonly namedBy = new Map<string, Set<string>>();
  /** The perspective of each assertion's current assertion, where it is not
   *  "enox" (most are: kept only for the others). */
  private readonly persp = new Map<string, string>();
  private edgeList: Edge[] | null = null;
  /** Subjects and assertions to re-derive at the next ensure(). */
  private readonly dirtySubjects = new Set<string>();
  private readonly dirtyEdges = new Set<string>();
  private readonly nodeRank = new Map<string, number>();
  private lastNodeRank = -1;

  static async load(node: RoflenoxNode, caller: string | null): Promise<Graph> {
    const g = new Graph();
    g.orderOf = (identity, seq) => node.writtenAt(identity, seq);
    const facts = (await node.ask('edge(F, S, R, T)', caller)).rows as { identity: string; cells: string[] }[];
    const seqRows = await node.ask('asserted(F, P, C, S)', caller).catch((e: unknown) => {
      if (e instanceof Refusal && e.reason === 'engine_down') throw e;     // never a plain answer from a dead engine
      return { rows: [] };
    });
    for (const r of seqRows.rows as { identity: string; cells: [string, string, number, number] }[]) {
      if ((g.seq.get(r.cells[0]) ?? -1) <= r.cells[3]) g.perspective(r.cells[0], r.cells[1]);
      g.seq.set(r.cells[0], Math.max(g.seq.get(r.cells[0]) ?? -1, r.cells[3]));
      g.wrote(r.cells[0], r.identity, r.cells[3]);
    }
    for (const r of (await node.ask('conf(F, C)', caller)).rows as { cells: [string, number] }[]) g.conf.set(r.cells[0], r.cells[1]);
    for (const { identity, cells: [F, S, R, T] } of facts) { g.hold(F!, S!, R!, T!); g.signedBy(F!, identity); }
    g.ensure();
    return g;
  }

  private perspective(F: string, P: string): void {
    if (P === ENOX_PERSPECTIVE) this.persp.delete(F); else this.persp.set(F, P);
  }

  private wrote(F: string, identity: string, seq: number): void {
    this.written.set(F, Math.max(this.written.get(F) ?? -1, this.orderOf(identity, seq)));
  }

  private signedBy(F: string, identity: string): void {
    const s = this.by.get(F);
    if (s) s.add(identity); else this.by.set(F, new Set([identity]));
  }

  /** Hold a fact in the raw state and mark what it changes. */
  private hold(F: string, S: string, R: string, T: string): void {
    if (!this.raw.has(F)) {
      this.rank.set(F, this.rank.size);
      if (R.startsWith('enox:')) {
        const a = R.slice(5);
        const m = this.attrFacts.get(S) ?? new Map<string, string[]>();
        m.set(a, [...(m.get(a) ?? []), F]);
        this.attrFacts.set(S, m);
        if (a === 'fact_id') {
          const n = this.namedBy.get(T);
          if (n) n.add(S); else this.namedBy.set(T, new Set([S]));
        }
      } else if (!R.startsWith('roflenox:')) {
        this.assertionIds.add(F);
        for (const x of [S, T]) {
          const t = this.touching.get(x);
          if (t) t.add(F); else this.touching.set(x, new Set([F]));
        }
      }
    }
    this.raw.set(F, { S, R, T });
    if (R.startsWith('enox:')) this.dirtySubjects.add(S);
    else if (!R.startsWith('roflenox:')) this.dirtyEdges.add(F);
  }

  /** Apply an admitted batch (its facts, at its chain position, signed by `identity`). */
  apply(facts: { source: string; relation: string; target: string; confidence: number }[], seq: number, identity: string): void {
    for (const f of facts) {
      const F = factId(f);
      this.conf.set(F, Math.round(f.confidence * 1000));
      this.seq.set(F, seq);
      this.perspective(F, f.perspective);
      this.wrote(F, identity, seq);
      this.hold(F, f.source, f.relation, f.target);
      this.signedBy(F, identity);
    }
  }

  /** Re-derive what was applied since: the entities and assertions touched. */
  ensure(): this {
    const subjects = [...this.dirtySubjects];
    this.dirtySubjects.clear();
    let reorder = false;
    for (const id of subjects) {
      const had = this.nodes.has(id);
      const n = this.nodeOf(id);
      const at = n ? this.firstAttr(id) : undefined;
      // A new entity later than every other one lands in place at the end.
      const appended = !had && n !== null && at! > this.lastNodeRank;
      if (n) this.nodes.set(id, n); else this.nodes.delete(id);
      if (appended) this.lastNodeRank = at!;
      else if (had !== (n !== null) || at !== this.nodeRank.get(id)) reorder = true;
      if (at === undefined) this.nodeRank.delete(id); else this.nodeRank.set(id, at);
      // An entity that appears or goes changes the assertions touching it; an
      // assertion's own attributes (context, asserted_by, …) change its edge.
      if (had !== (n !== null)) for (const F of this.touching.get(id) ?? []) this.dirtyEdges.add(F);
      if (this.assertionIds.has(id)) this.dirtyEdges.add(id);
    }
    // Entities in the order a full derivation meets them: by the first
    // current attribute fact of each.
    if (reorder) {
      this.nodes = new Map([...this.nodes].sort((x, y) => this.nodeRank.get(x[0])! - this.nodeRank.get(y[0])!));
      this.lastNodeRank = Math.max(-1, ...[...this.nodes.keys()].slice(-1).map((id) => this.nodeRank.get(id)!));
    }
    for (const F of this.dirtyEdges) this.deriveEdge(F);
    if (this.dirtyEdges.size) this.edgeList = null;
    this.dirtyEdges.clear();
    return this;
  }

  /** The first-seen current (not retired) attribute fact of a subject, but aliases. */
  private firstAttr(s: string): number | undefined {
    let min: number | undefined;
    for (const [a, Fs] of this.attrFacts.get(s) ?? []) {
      if (a === 'alias') continue;
      for (const F of Fs) {
        if ((this.conf.get(F) ?? 1) === 0) continue;
        const r = this.rank.get(F)!;
        if (min === undefined || r < min) min = r;
        break;                                                        // Fs is in first-seen order
      }
    }
    return min;
  }

  /** A single-valued attribute: its latest assertion in the chain (the later
   *  fact on a tie), retired ones skipped. */
  private attr(s: string, a: string): string | undefined {
    let best: [number, string] | undefined;
    for (const F of this.attrFacts.get(s)?.get(a) ?? []) {
      if ((this.conf.get(F) ?? 1) === 0) continue;                    // retired (confidence 0)
      const sq = this.seq.get(F) ?? 0;
      if (!best || sq >= best[0]) best = [sq, this.raw.get(F)!.T];
    }
    return best?.[1];
  }

  private nodeOf(id: string): Node | null {
    const attr = (a: string) => this.attr(id, a);
    if (attr('label') === undefined && attr('type') === undefined) return null;
    const listed = attr('aliases');
    const aliases = (this.attrFacts.get(id)?.get('alias') ?? []).filter((F) => (this.conf.get(F) ?? 1) !== 0).map((F) => this.raw.get(F)!.T);
    return {
      id, type: attr('type') ?? 'concept', domain: attr('domain') ?? '', name: attr('label') ?? '',
      description: attr('description') ?? '', aliases: listed !== undefined ? JSON.parse(listed) as string[] : [...new Set(aliases)].sort(),
      source_ref: attr('source_ref') ?? '', created_at: attr('created_at') ?? null, updated_at: attr('updated_at') ?? null,
      attrs: new Map(SINGLE.map((a) => [a, attr(a)]).filter(([, v]) => v !== undefined) as [string, string][]),
    };
  }

  private deriveEdge(F: string): void {
    const old = this.edgeOf.get(F);
    if (old) {
      this.edgeOf.delete(F);
      this.outOf.get(old.source)?.delete(F);
      this.inOf.get(old.target)?.delete(F);
      this.byFactId.get(old.fact_id)?.delete(F);
    }
    const a = this.raw.get(F)!;
    const c = this.conf.get(F);
    if (c === undefined || c === 0) return;                           // deleted (or not visible)
    if (!this.nodes.has(a.S) || !this.nodes.has(a.T)) return;
    const attr = (x: string) => this.attr(F, x);
    let written = this.written.get(F) ?? -1;
    for (const Fs of this.attrFacts.get(F)?.values() ?? []) {
      for (const G of Fs) if ((this.conf.get(G) ?? 1) !== 0) written = Math.max(written, this.written.get(G) ?? -1);
    }
    const e: Edge = {
      F, fact_id: attr('fact_id') ?? enoxFactId(a.S, a.R, a.T), source: a.S, target: a.T, relation: a.R,
      confidence: c / 1000, asserted_by: [...(this.by.get(F) ?? [])].sort().join(', ') || null, claimed_by: attr('asserted_by') ?? null, context: attr('context') ?? '',
      proof_depth: Number(attr('proof_depth') ?? 0), created_at: attr('created_at') ?? null, updated_at: attr('updated_at') ?? null, written,
    };
    this.edgeOf.set(F, e);
    for (const [m, k] of [[this.outOf, e.source], [this.inOf, e.target], [this.byFactId, e.fact_id]] as const) {
      const set = m.get(k);
      if (set) set.add(F); else m.set(k, new Set([F]));
    }
  }

  private inOrder(Fs: Iterable<string> | undefined): Edge[] {
    return [...(Fs ?? [])].sort((x, y) => this.rank.get(x)! - this.rank.get(y)!).map((F) => this.edgeOf.get(F)!);
  }

  /** Every edge, in the order the facts were first seen. */
  get edges(): Edge[] {
    this.edgeList ??= this.inOrder(this.edgeOf.keys());
    return this.edgeList;
  }

  /** The edge an id names (r_one_fact_id): the fact id ask returns (F), or
   *  an Enox fact_id (the first seen, if several edges carry it). */
  edgeByFactId(id: string): Edge | undefined {
    return this.edgeOf.get(id) ?? this.inOrder(this.byFactId.get(id))[0];
  }

  /** The assertion an id names, whether or not it is an edge of the view —
   *  deleted (confidence 0), or between values that are not entities, under
   *  any perspective: its F, its triple, and its current assertion. */
  assertion(id: string): { F: string; S: string; R: string; T: string; P: string; confidence: number; fact_id: string } | undefined {
    const e = this.edgeByFactId(id);
    const F = e?.F ?? (this.assertionIds.has(id) ? id : [...(this.namedBy.get(id) ?? [])].filter((G) => this.assertionIds.has(G))
      .sort((x, y) => this.rank.get(x)! - this.rank.get(y)!)[0]);
    if (F === undefined) return undefined;
    const a = this.raw.get(F)!;
    return { F, S: a.S, R: a.R, T: a.T, P: this.persp.get(F) ?? ENOX_PERSPECTIVE, confidence: (this.conf.get(F) ?? 0) / 1000,
      fact_id: e?.fact_id ?? this.attr(F, 'fact_id') ?? enoxFactId(a.S, a.R, a.T) };
  }

  record(n: Node) {
    return { id: n.id, type: n.type, domain: n.domain, name: n.name, description: n.description, aliases: n.aliases, source_ref: n.source_ref,
      created_at: n.created_at, updated_at: n.updated_at };
  }

  row(e: Edge) {
    const s = this.nodes.get(e.source)!, t = this.nodes.get(e.target)!;
    return { fact_id: e.fact_id, edge_id: e.F, source: e.source, source_name: s.name, source_type: s.type, target: e.target, target_name: t.name, target_type: t.type,
      relation: e.relation, asserted_by: e.asserted_by, claimed_by: e.claimed_by, confidence: e.confidence, context: e.context, created_at: e.created_at, updated_at: e.updated_at };
  }

  /** Enox's resolveNode: exact id, then name (case-insensitive), then name contains. */
  resolve(term: string): Node | null {
    if (this.nodes.has(term)) return this.nodes.get(term)!;
    const lt = term.toLowerCase();
    const all = [...this.nodes.values()];
    return all.find((n) => n.name.toLowerCase() === lt) ?? all.find((n) => n.name.toLowerCase().includes(lt)) ?? null;
  }

  out(id: string) { return this.inOrder(this.outOf.get(id)); }
  in(id: string) { return this.inOrder(this.inOf.get(id)); }
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
/** `signer` is the identity the batch will be signed as — who the result says
 *  asserted it; `a.asserted_by` (or `agent`) is kept as the batch's claim. */
export function addFacts(g: Graph, a: AddArgs, agent: string, created: Map<string, Node>, signer: string) {
  // proof_depth is an integer (PROTOCOL); batch items are not schema-checked.
  if (a.proof_depth !== undefined && !Number.isInteger(a.proof_depth)) throw new Refusal(400, 'bad_args', `proof_depth is an integer, not ${JSON.stringify(a.proof_depth)}`);
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
  const existing = g.edgeByFactId(fid);
  const F = factId({ source: sid, relation: a.relation, target: tid });
  const confidence = a.confidence ?? 1;
  const by = (typeof a.asserted_by === 'string' && a.asserted_by.trim()) || agent;     // never empty (r_claimed_author)
  facts.push({ source: sid, relation: a.relation, target: tid, perspective: ENOX_PERSPECTIVE, confidence },
    meta(F, 'asserted_by', by), meta(F, 'fact_id', fid), meta(F, 'updated_at', t));
  if (a.context) facts.push(meta(F, 'context', a.context));
  if (!existing) facts.push(meta(F, 'created_at', t), meta(F, 'proof_depth', a.proof_depth ?? 0));
  const result = { fact_id: fid, edge_id: F, source: sid, target: tid, relation: a.relation, asserted_by: signer, claimed_by: by, confidence,
    proof_depth: existing ? existing.proof_depth : a.proof_depth ?? 0, context: a.context ?? '', created: !existing, updated: !!existing };
  return { facts, result, inverse: g.out(tid).find((e) => e.target === sid && e.relation === a.relation) };
}

export { enoxFactId, meta, entityFacts, uniq, ENOX_PERSPECTIVE, STALE_TTL, META };

export function refuseText(text: string): Refusal {
  return new Refusal(404, 'enox_error', text, { plain: true });
}
