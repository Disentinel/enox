// The Enox tools as rows of the operation table (r_enox_compat). Names,
// argument names and answer shapes are Enox's (smart-node/src/mcp, 2026-09-26);
// what answers them is ask over facts and signed batches through admission.
import { createHash } from 'node:crypto';
import { Refusal, type Fact } from './facts.ts';
import type { RoflenoxNode } from './node.ts';
import {
  addFacts, deriveDescription, ENOX_PERSPECTIVE, entityFacts, Graph, meta, refuseText, slugify, STALE_TTL, truncateAtWordBoundary,
  uniq, uriPrefix, type AddArgs, type Edge,
} from './enox.ts';
import type { Ctx, Op, Prop, Schema } from './ops.ts';

const obj = (properties: Record<string, Prop>, required: string[] = []): Schema =>
  ({ type: 'object', required, properties, additionalProperties: false });
const s = (description?: string): Prop => ({ type: 'string', ...(description ? { description } : {}) });
const n = (description?: string): Prop => ({ type: 'number', ...(description ? { description } : {}) });
const int = (description?: string): Prop => ({ type: 'integer', ...(description ? { description } : {}) });
const b = (description?: string): Prop => ({ type: 'boolean', ...(description ? { description } : {}) });
const pretty = (r: unknown) => JSON.stringify(r, null, 2);
const plain = (r: unknown) => String(r);

function node(ctx: Ctx): RoflenoxNode {
  if (!ctx.node) throw new Refusal(500, 'no_node', 'this operation runs inside a node');
  return ctx.node;
}

/** The Enox view. Only the node's OWN identity's view is kept (what Enox
 *  clients reach with the operator token): an admitted batch is APPLIED to it
 *  from the node's record of recent admissions — no rebuild (r_batch_write).
 *  Any other caller's view depends on its grants and exports and is built for
 *  the call and dropped: the node keeps no state per client (r_session_eviction). */
let kept: { node: RoflenoxNode; owner: string; g: Graph; version: number } | null = null;
async function graph(ctx: Ctx): Promise<Graph> {
  const n = node(ctx);
  const own = n.identity?.name;
  if (ctx.caller === null || ctx.caller !== own) return Graph.load(n, ctx.caller);
  // The kept view is of ONE node: another node in this process (a test, an
  // embedding host) with an operator of the same name never reads it.
  if (kept && kept.node === n && kept.owner === own) {
    if (kept.version === n.logVersion()) return kept.g.ensure();
    const since = n.admittedSince(kept.version);
    if (since) {
      for (const b of since) kept.g.apply(b.facts, b.seq, b.identity);
      kept.version = n.logVersion();
      return kept.g.ensure();
    }
  }
  const g = await Graph.load(n, own);
  kept = { node: n, owner: own, g, version: n.logVersion() };
  return g;
}

/** How many Enox views are held in memory (at most one: the node's own). */
export function heldViews(): number {
  return kept ? 1 : 0;
}

/** Who an Enox write claims when it names no asserted_by: the OAuth client
 *  the owner approved, else the operator — never empty (r_claimed_author). */
const agent = (ctx: Ctx) => ctx.agent?.trim() || 'operator';
/** The identity every Enox write is signed as: the node's own. */
const self = (ctx: Ctx) => node(ctx).identity!.name;

async function write(ctx: Ctx, facts: Fact[]): Promise<void> {
  if (facts.length) await node(ctx).assertAsSelf(uniq(facts));
}

/** Enox's staleness, as the base adds it to semantic_search rows: the age of
 *  the entity's updated_at in whole days, and stale past its domain's TTL. */
function staleness<T extends { domain: string; updated_at: string | null }>(row: T, now: number): T & { age_days?: number; stale?: boolean } {
  if (!row.updated_at) return row;
  const age_days = Math.round((now - Date.parse(row.updated_at)) / 86_400_000);
  return { ...row, age_days, stale: age_days > (STALE_TTL[row.domain || 'default'] ?? STALE_TTL_DEFAULT) };
}
const STALE_TTL_DEFAULT = 365;
/** How many domain/type buckets graph_stats names by default (r_stats_bounded). */
export const STATS_TOP = 20;

const cmpDesc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
const confStr = (e: Edge) => (e.confidence < 1 ? ` (${e.confidence})` : '');
const byStr = (e: Edge) => (e.asserted_by ? ` [by ${e.asserted_by}${e.claimed_by ? `, claims ${JSON.stringify(e.claimed_by)}` : ''}]` : '');
const NOT_FOUND = (term: string) => refuseText(`Entity "${term}" not found`);

const ASSERTION: Record<string, Prop> = {
  source: s(), target: s(), relation: s(), source_type: s(), source_domain: s(), target_type: s(), target_domain: s(),
  confidence: n(), context: s(), asserted_by: s(), proof_depth: int('an integer (PROTOCOL): the depth of the proof behind the assertion'),
};

export const ENOX_OPS: Op[] = [
  // ---- reads ---------------------------------------------------------------
  { name: 'query_graph', description: 'Search nodes by name/type, or pass node_id to get a node plus its neighbors.',
    input: obj({ query: s(), node_id: s(), relation: s(), type: s() }), access: 'anyone', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      if (a.node_id !== undefined) {
        const rel = (e: Edge) => a.relation === undefined || e.relation === a.relation;
        const nd = g.nodes.get(a.node_id as string);
        return { node: nd ? g.record(nd) : null, outgoing: g.out(a.node_id as string).filter(rel).map((e) => g.row(e)),
          incoming: g.in(a.node_id as string).filter(rel).map((e) => g.row(e)) };
      }
      const q = (a.query as string | undefined)?.toLowerCase();
      return [...g.nodes.values()].filter((x) => (q === undefined || x.name.toLowerCase().includes(q)) && (a.type === undefined || x.type === a.type))
        .map((x) => g.record(x));
    } },
  // Bounded by default (r_stats_bounded) — a deliberate departure from Enox,
  // whose answer ran to ~39 KB on the owner's book: totals, every relation,
  // and the STATS_TOP largest domain/type buckets with a count of the rest.
  // `full: true` is Enox's whole breakdown, in Enox's shape.
  { name: 'graph_stats', description: `Node/edge counts: totals, every relation, and the ${STATS_TOP} largest domain/type buckets with a count of the rest. full: true gives every domain/type bucket (Enox's whole breakdown).`,
    input: obj({ full: b('every domain/type bucket, as Enox gave them') }), access: 'anyone',
    text: (r) => ((r as { full?: unknown }).full === undefined ? pretty(r) : JSON.stringify(r)),
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const dt = new Map<string, { domain: string; type: string; cnt: number }>();
      for (const x of g.nodes.values()) {
        const k = `${x.domain}\u0000${x.type}`;
        dt.set(k, { domain: x.domain, type: x.type, cnt: (dt.get(k)?.cnt ?? 0) + 1 });
      }
      const rel = new Map<string, number>();
      for (const e of g.edges) rel.set(e.relation, (rel.get(e.relation) ?? 0) + 1);
      if (a.full === true) {
        return { total_nodes: g.nodes.size, total_edges: g.edges.length, by_domain: [...dt.values()],
          by_relation: [...rel].map(([relation, cnt]) => ({ relation, cnt })) };
      }
      const bySize = <T>(xs: T[], n: (x: T) => number, k: (x: T) => string) => xs.sort((x, y) => n(y) - n(x) || (k(x) < k(y) ? -1 : k(x) > k(y) ? 1 : 0));
      const buckets = bySize([...dt.values()], (x) => x.cnt, (x) => `${x.domain}\u0000${x.type}`);
      const rest = buckets.slice(STATS_TOP);
      return { total_nodes: g.nodes.size, total_edges: g.edges.length,
        by_relation: Object.fromEntries(bySize([...rel], ([, c]) => c, ([r]) => r)),
        by_domain: buckets.slice(0, STATS_TOP), by_domain_rest: { buckets: rest.length, nodes: rest.reduce((t, x) => t + x.cnt, 0) },
        full: rest.length ? `the ${STATS_TOP} largest of ${buckets.length} domain/type buckets; full: true gives them all` : `all ${buckets.length} domain/type buckets` };
    } },
  { name: 'explore', description: 'Show one entity and all its incoming/outgoing relationships as readable text.', input: obj({ entity: s() }, ['entity']),
    access: 'anyone', text: plain,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const x = g.resolve(a.entity as string);
      if (!x) throw NOT_FOUND(a.entity as string);
      const L = [`# ${x.name} (${x.type}, ${x.domain})`];
      if (x.description) L.push(`> ${x.description}`);
      if (x.source_ref) L.push(`Source: ${x.source_ref}`);
      L.push(`Created: ${x.created_at} | Updated: ${x.updated_at}`, '');
      const out = g.out(x.id), inc = g.in(x.id);
      if (out.length) {
        L.push(`## Outgoing (${out.length})`);
        for (const e of out) {
          L.push(`  ${x.name} --[${e.relation}]--> ${g.nodes.get(e.target)!.name}${confStr(e)}${byStr(e)}`);
          if (e.context) L.push(`    context: ${e.context.slice(0, 200)}`);
        }
        L.push('');
      }
      if (inc.length) {
        L.push(`## Incoming (${inc.length})`);
        for (const e of inc) {
          L.push(`  ${g.nodes.get(e.source)!.name} --[${e.relation}]--> ${x.name}${confStr(e)}${byStr(e)}`);
          if (e.context) L.push(`    context: ${e.context.slice(0, 200)}`);
        }
      }
      return L.join('\n');
    } },
  { name: 'traverse', description: 'Multi-hop BFS from a starting entity — "what connects to X within N hops".',
    input: obj({ entity: s(), max_depth: n(), relation: s(), direction: s('out | in | both') }, ['entity']), access: 'anyone', text: plain,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const start = g.resolve(a.entity as string);
      if (!start) throw NOT_FOUND(a.entity as string);
      const depth = Math.min(3, Math.max(1, (a.max_depth as number | undefined) ?? 2));
      const dir = (a.direction as string | undefined) ?? 'both';
      const seen = new Set([start.id]);
      const byDepth: Edge[][] = [];
      const edgeKeys = new Set<string>();
      let frontier = [start.id];
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next: string[] = [];
        const level: Edge[] = [];
        for (const id of frontier.slice(0, 25)) {
          const cand = [...(dir !== 'in' ? g.out(id) : []), ...(dir !== 'out' ? g.in(id) : [])]
            .filter((e) => a.relation === undefined || e.relation === a.relation);
          for (const e of cand) {
            const k = `${e.source}|${e.relation}|${e.target}`;
            if (edgeKeys.has(k)) continue;
            edgeKeys.add(k);
            level.push(e);
            for (const o of [e.source, e.target]) if (!seen.has(o)) { seen.add(o); next.push(o); }
          }
        }
        byDepth.push(level.sort((x, y) => y.confidence - x.confidence));
        frontier = next;
      }
      const head = `# Traverse: ${start.name} (depth ≤ ${depth}${a.relation ? `, relation=${a.relation}` : ''}${dir !== 'both' ? `, direction=${dir}` : ''})`;
      const L = [head, `Discovered ${seen.size} nodes, ${edgeKeys.size} edges`, ''];
      byDepth.forEach((lv, i) => {
        if (!lv.length) return;
        L.push(`## Depth ${i + 1} (${lv.length} edges)`);
        for (const e of lv) {
          L.push(`  ${g.nodes.get(e.source)!.name} --[${e.relation}]--> ${g.nodes.get(e.target)!.name}${confStr(e)}${byStr(e)}`);
          if (e.context) L.push(`    ${e.context.slice(0, 150)}`);
        }
        L.push('');
      });
      return L.join('\n');
    } },
  { name: 'recall', description: 'Broad "what do we know about X" — names and meaning (the meaning part is the embedder executor\'s, when one is named), packed into a token budget.',
    input: obj({ query: s(), budget: n(), domain: s() }, ['query']), access: 'anyone',
    text: (r) => ((r as { message?: string }).message ? JSON.stringify(r) : pretty(r)),
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const q = (a.query as string).toLowerCase();
      const budget = (a.budget as number | undefined) ?? 1500;
      const chars = budget * 4;
      const inDomain = (x: { domain: string }) => a.domain === undefined || x.domain.startsWith(a.domain as string);
      const hits = [...g.nodes.values()].filter((x) => x.name.toLowerCase().includes(q) && inDomain(x))
        .slice(0, 20).map((x) => ({ x, score: x.name.toLowerCase() === q ? 10 : 5 }));
      // Meaning as well as names, as the base does: the embedder's answer to
      // this search (the operator's recall asks it, like semantic_search), its
      // entity hits at 0.25 and above weighted 5×. With no embedder named, or
      // before it has answered, recall is the name match alone.
      const meant = await node(ctx).meaningSearch(a.query as string, ctx.caller);
      if (meant.state === 'answered') {
        for (const h of meant.hits) {
          if (h.kind !== 'node' || h.score < 0.25) continue;
          const had = hits.find((p) => p.x.id === h.id);
          if (had) { had.score += h.score * 5; continue; }
          const x = g.nodes.get(h.id);                  // only what the caller may read
          if (x && inDomain(x)) hits.push({ x, score: h.score * 5 });
        }
      }
      hits.sort((p, r) => r.score - p.score);
      if (!hits.length) return { nodes: [], edges: [], message: 'No matches found' };
      let used = 0;
      const nodes: unknown[] = [];
      for (const { x, score } of hits.slice(0, 30)) {
        const cost = `${x.name} (${x.type}): ${x.description}`.length;
        if (used + cost > chars) break;
        used += cost;
        nodes.push({ name: x.name, type: x.type, description: x.description, ...(x.source_ref ? { source_ref: x.source_ref } : {}), score: Number(score.toFixed(1)) });
      }
      const seeds = hits.slice(0, 10).map((h) => h.x.id);
      const keys = new Set<string>();
      const edges: unknown[] = [];
      for (const e of seeds.flatMap((id) => [...g.out(id), ...g.in(id)]).sort((p, r) => r.confidence - p.confidence)) {
        const k = `${e.source}|${e.relation}|${e.target}`;
        if (keys.has(k)) continue;
        keys.add(k);
        const sn = g.nodes.get(e.source)!.name, tn = g.nodes.get(e.target)!.name;
        const cost = `${sn} --[${e.relation}]--> ${tn}`.length + e.context.length;
        if (used + cost > chars) continue;
        used += cost;
        edges.push({ source: sn, relation: e.relation, target: tn, ...(e.asserted_by ? { asserted_by: e.asserted_by } : {}), ...(e.claimed_by ? { claimed_by: e.claimed_by } : {}), confidence: e.confidence, context: e.context });
      }
      return { nodes, edges, seeds: hits.slice(0, 5).map((h) => h.x.name), budget_used: Math.ceil(used / 4), budget_total: budget };
    } },
  { name: 'semantic_search', description: 'Search by meaning. The embedder executor answers (r_semantic_search); until it has, the answer says so and never guesses. An answer is in the log: it stays when the embedder is gone.',
    input: obj({ query: s(), top_k: n(), domain: s(), include_edges: b() }, ['query']), access: 'anyone', text: pretty,
    run: async (ctx, a) => {
      const r = await node(ctx).meaningSearch(a.query as string, ctx.caller);
      const none = (index: string, message: string) => ({ nodes: [], ...(a.include_edges ? { edges: [] } : {}), index, message });
      if (r.state === 'no_embedder') {
        return none('absent', 'no semantic index on this node: search by meaning is the embedder executor\'s, and none is named (a roflenox:embedder fact). Use recall or query_graph for text matches.');
      }
      if (r.state !== 'answered') {
        return none('pending', r.state === 'pending'
          ? `asked ${r.embedder} to search by meaning; it has not answered yet — ask again shortly.`
          : 'this search has not been asked by the node\'s operator; nothing to answer yet.');
      }
      // Hits the CALLER may not read are not in its view, and so not answered.
      const g = await graph(ctx);
      const topK = (a.top_k as number | undefined) ?? 10;
      const domain = a.domain as string | undefined;
      const sim = (x: number) => Math.round(x * 1000) / 1000;
      const nodes = r.hits.filter((h) => h.kind === 'node').map((h) => ({ h, nd: g.nodes.get(h.id) }))
        .filter(({ nd }) => nd && (domain === undefined || nd.domain.startsWith(domain)))
        .slice(0, topK).map(({ h, nd }) => staleness({ ...g.record(nd!), similarity: sim(h.score) }, ctx.now()));
      const byF = new Map(g.edges.map((e) => [e.F, e]));
      const edges = r.hits.filter((h) => h.kind === 'fact').map((h) => ({ h, e: byF.get(h.id) }))
        .filter(({ e }) => e && (domain === undefined || (g.nodes.get(e.source)?.domain ?? '').startsWith(domain)))
        .slice(0, topK).map(({ h, e }) => ({ ...g.row(e!), similarity: sim(h.score) }));
      return { nodes, ...(a.include_edges ? { edges } : {}), index: `embedder:${r.embedder}`,
        message: `${nodes.length} entities${a.include_edges ? ` and ${edges.length} assertions` : ''} by meaning, answered by ${r.embedder}` };
    } },
  { name: 'recent_activity', description: 'The most recently written assertions, newest first: by when this node received the write (an updated_at is only what its writer claims), the same order with any limit.',
    input: obj({ since: s(), limit: n() }), access: 'anyone', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const since = a.since as string | undefined;
      // One total order (r_recent_order): the log first, then the claimed
      // time, then the fact — so no limit and no rebuild of the view moves a row.
      return g.edges.filter((e) => since === undefined || (e.updated_at ?? '') >= since)
        .sort((x, y) => y.written - x.written || cmpDesc(x.updated_at ?? '', y.updated_at ?? '') || (x.F < y.F ? -1 : x.F > y.F ? 1 : 0))
        .slice(0, (a.limit as number | undefined) ?? 20)
        .map((e) => ({ source_name: g.nodes.get(e.source)!.name, source_id: e.source, relation: e.relation, target_name: g.nodes.get(e.target)!.name,
          target_id: e.target, asserted_by: e.asserted_by, claimed_by: e.claimed_by, confidence: e.confidence, context: e.context,
          created_at: e.created_at, updated_at: e.updated_at }));
    } },
  { name: 'decide', description: 'Rank candidate approaches for a task from the graph (text matches; the semantic part needs the embedder).',
    input: obj({ task: s(), constraints: { type: 'array' }, limit: n() }, ['task']), access: 'anyone',
    text: (r) => ((r as { message?: string }).message ? JSON.stringify(r) : pretty(r)),
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const task = a.task as string;
      const constraints = ((a.constraints as string[] | undefined) ?? []).map((c) => c.toLowerCase());
      const seeds = [...g.nodes.values()].filter((x) => x.name.toLowerCase().includes(task.toLowerCase())).slice(0, 10);
      const cand = new Map<string, { id: string; score: number; wins: number; failures: number; notes: string[] }>();
      for (const sd of seeds) {
        for (const e of g.in(sd.id).filter((e) => ['enables', 'implements', 'depends_on', 'introduces', 'is_based_on'].includes(e.relation))) {
          const c = cand.get(e.source) ?? { id: e.source, score: 0, wins: 0, failures: 0, notes: [] };
          c.score += e.confidence;
          if (e.context) c.notes.push(e.context.slice(0, 100));
          cand.set(e.source, c);
        }
        if (!cand.has(sd.id)) cand.set(sd.id, { id: sd.id, score: 1, wins: 0, failures: 0, notes: [] });
      }
      if (!cand.size) return { task, recommendations: [], message: 'No candidates found' };
      const kept = [...cand.values()].filter((c) => {
        for (const e of g.out(c.id)) {
          if (['supersedes', 'outperforms'].includes(e.relation)) { c.wins++; c.score += e.confidence * 0.5; }
          if (['contradicts', 'fails_on'].includes(e.relation)) {
            c.failures++; c.score -= e.confidence * 0.3;
            const hay = `${g.nodes.get(e.target)!.name} ${e.context}`.toLowerCase();
            if (constraints.some((k) => hay.includes(k))) return false;
          }
        }
        return true;
      }).sort((x, y) => y.score - x.score).slice(0, (a.limit as number | undefined) ?? 10);
      return { task, constraints: a.constraints ?? [], recommendations: kept.map((c, i) => {
        const x = g.nodes.get(c.id)!;
        return { rank: i + 1, name: x.name, type: x.type, description: x.description.slice(0, 200), score: Number(c.score.toFixed(2)),
          wins: c.wins, known_failures: c.failures, notes: c.notes.slice(0, 3) };
      }), total_candidates: cand.size, after_filtering: kept.length };
    } },
  // ---- writes: new assertions of the node's own identity; nothing is ever removed ----
  { name: 'add_assertion', description: 'Assert a relation between two entities (created by name if missing); an existing fact is re-asserted.',
    input: obj(ASSERTION, ['source', 'target', 'relation']), access: 'operator', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const { facts, result, inverse } = addFacts(g, a as unknown as AddArgs, agent(ctx), new Map(), self(ctx));
      await write(ctx, facts);
      const warn = inverse && ['supersedes', 'outperforms', 'contradicts'].includes(result.relation)
        ? { warnings: [`Potential contradiction: inverse "${result.relation}" assertion exists from target to source (fact_id: ${inverse.fact_id})`] } : {};
      return { ...result, ...warn };
    } },
  { name: 'batch_assertions', description: 'Up to 50 add_assertion calls in one signed batch.', input: obj({ assertions: { type: 'array' } }, ['assertions']),
    access: 'operator', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const created = new Map();
      const all: Fact[] = [];
      const results = (a.assertions as AddArgs[]).map((x) => {
        try {
          if (!x.source || !x.target || !x.relation) throw new Error('source, target and relation are required');
          const r = addFacts(g, x, agent(ctx), created, self(ctx));
          all.push(...r.facts);
          return { fact_id: r.result.fact_id, source: r.result.source, target: r.result.target, relation: r.result.relation, asserted_by: r.result.asserted_by, claimed_by: r.result.claimed_by, ok: true, created: r.result.created };
        } catch (e) {
          return { fact_id: '', source: x.source, target: x.target, relation: x.relation, ok: false, error: String(e) };
        }
      });
      await write(ctx, all);
      return { succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    } },
  { name: 'remember', description: 'Record a fact about a subject: a fact node linked from the subject.',
    input: obj({ subject: s(), fact: s(), relation: s(), domain: s(), confidence: n(), asserted_by: s() }, ['subject', 'fact']), access: 'operator', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const subject = a.subject as string, fact = a.fact as string, domain = (a.domain as string | undefined) ?? 'memory';
      const t = new Date().toISOString();
      const facts: Fact[] = [];
      let subj = g.resolve(subject);
      if (!subj) {
        const id = `${uriPrefix()}/${domain}/${slugify(subject)}`;
        facts.push(...entityFacts(id, subject, 'concept', domain, deriveDescription(fact), t));
        subj = { id, name: subject } as never;
      }
      const lf = fact.toLowerCase();
      const factType = /decided|decision|chose/.test(lf) ? 'decision' : /prefer|better/.test(lf) ? 'preference' : /reject|avoid|don't/.test(lf) ? 'rejected_alternative' : 'belief';
      const relation = (a.relation as string | undefined) ?? (/replaces|instead of|supersede/.test(lf) ? 'supersedes' : /contradict|conflict|actually/.test(lf) ? 'contradicts'
        : /depends|requires|needs/.test(lf) ? 'depends_on' : /enables|allows|makes possible/.test(lf) ? 'enables' : 'about');
      const fid = `${uriPrefix()}/${domain}/fact_${slugify(fact.substring(0, 60))}_${createHash('sha256').update(fact).digest('hex').slice(0, 8)}`;
      if (!g.nodes.has(fid)) facts.push(...entityFacts(fid, truncateAtWordBoundary(fact, 300), factType, domain, fact, t));
      const r = addFacts(g, { source: subj!.id, target: fid, relation, confidence: (a.confidence as number | undefined) ?? 0.9, context: fact,
        asserted_by: a.asserted_by as string | undefined }, agent(ctx), new Map([[fid, { id: fid } as never], [subj!.id, { id: subj!.id } as never]]), self(ctx));
      facts.push(...r.facts);
      await write(ctx, facts);
      return { subject: { id: subj!.id, name: subj!.name }, fact: { id: fid, text: truncateAtWordBoundary(fact, 300) }, relation,
        asserted_by: r.result.asserted_by, claimed_by: r.result.claimed_by, fact_id: r.result.fact_id, created: r.result.created };
    } },
  { name: 'update_assertion', description: 'Change an assertion\'s confidence/context/author: a new assertion that supersedes.',
    input: obj({ fact_id: s(), confidence: n(), context: s(), asserted_by: s(), proof_depth: ASSERTION.proof_depth! }, ['fact_id']), access: 'operator', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const e = g.edgeByFactId(a.fact_id as string);
      if (!e) throw refuseText(`Assertion ${a.fact_id} not found`);
      const t = new Date().toISOString();
      const confidence = (a.confidence as number | undefined) ?? e.confidence;
      const facts: Fact[] = [{ source: e.source, relation: e.relation, target: e.target, perspective: ENOX_PERSPECTIVE, confidence }, meta(e.F, 'updated_at', t)];
      if (a.context !== undefined) facts.push(meta(e.F, 'context', a.context as string));
      const claim = (a.asserted_by as string | undefined)?.trim();
      if (claim) facts.push(meta(e.F, 'asserted_by', claim));
      if (a.proof_depth !== undefined) facts.push(meta(e.F, 'proof_depth', a.proof_depth as number));
      await write(ctx, facts);
      return { fact_id: e.fact_id, source: e.source, target: e.target, relation: e.relation, asserted_by: self(ctx), claimed_by: claim || e.claimed_by,
        confidence, proof_depth: (a.proof_depth as number | undefined) ?? e.proof_depth, context: (a.context as string | undefined) ?? e.context, updated_at: t };
    } },
  { name: 'delete_assertion', description: 'Retire an assertion: re-asserted with confidence 0 (the log keeps its history).',
    input: obj({ fact_id: s() }, ['fact_id']), access: 'operator', text: plain,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const e = g.edgeByFactId(a.fact_id as string);
      if (!e) throw refuseText(`Assertion ${a.fact_id} not found`);
      await write(ctx, [{ source: e.source, relation: e.relation, target: e.target, perspective: ENOX_PERSPECTIVE, confidence: 0 },
        meta(e.F, 'deleted_at', new Date().toISOString())]);
      return `Deleted assertion ${a.fact_id}`;
    } },
  { name: 'update_node', description: 'Change an entity\'s name, description or aliases: new attribute facts that supersede.',
    input: obj({ node_id: s(), name: s(), description: s(), aliases: { type: 'array' } }, ['node_id']), access: 'operator', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const x = g.nodes.get(a.node_id as string);
      if (!x) throw refuseText(`Node ${a.node_id} not found`);
      const t = new Date().toISOString();
      const f = (attr: string, v: string) => ({ source: x.id, relation: `enox:${attr}`, target: v, perspective: ENOX_PERSPECTIVE, confidence: 1 });
      const facts: Fact[] = [f('updated_at', t)];
      if (a.name !== undefined) facts.push(f('label', a.name as string));
      if (a.description !== undefined && a.description !== '') facts.push(f('description', a.description as string));
      if (a.aliases !== undefined) facts.push(f('aliases', JSON.stringify(a.aliases)));
      await write(ctx, facts);
      return { id: x.id, type: x.type, name: (a.name as string | undefined) ?? x.name, description: (a.description as string | undefined) ?? x.description,
        aliases: (a.aliases as string[] | undefined) ?? x.aliases, updated_at: t };
    } },
  // ---- artifacts: an artifact is an entity whose body is one of its facts ----
  { name: 'create_artifact', description: 'Store a document as an entity (body as a fact), deduplicated by content hash, with optional links.',
    input: obj({ title: s(), domain: s(), content_type: s(), body: s(), encoding: s(), filename: s(), parse_okf: b(), links: { type: 'array' } },
      ['title', 'domain', 'content_type', 'body']), access: 'operator',
    text: (r) => (r as { text: string }).text,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const body = (a.encoding === 'base64') ? Buffer.from(a.body as string, 'base64').toString('utf8') : a.body as string;
      const sha = createHash('sha256').update(body).digest('hex');
      const domain = a.domain as string;
      const existing = [...g.nodes.values()].find((x) => x.type === 'artifact' && x.domain === domain && x.attrs.get('sha256') === sha);
      const size = Buffer.byteLength(body);
      if (existing) {
        const id = existing.attrs.get('artifact_id')!;
        return { id, entity_id: existing.id, content_type: existing.attrs.get('content_type'), title: existing.name, domain, size, sha256: sha, deduped: true,
          links_created: 0, edges_materialized: 0,
          text: `Artifact "${existing.name}" already existed in domain "${domain}" (deduped by content hash).\nid: ${id}\nentity_id: ${existing.id}\nsize: ${size} bytes, sha256: ${sha}` };
      }
      const id = createHash('sha256').update(`${domain}|${sha}`).digest('base64url').slice(0, 12);
      const eid = `${uriPrefix()}/${domain}/artifact-${id}`;
      const t = new Date().toISOString();
      const f = (attr: string, v: string) => ({ source: eid, relation: `enox:${attr}`, target: v, perspective: ENOX_PERSPECTIVE, confidence: 1 });
      const facts: Fact[] = [...entityFacts(eid, a.title as string, 'artifact', domain, '', t), f('artifact_id', id), f('content_type', a.content_type as string),
        f('body', body), f('sha256', sha), f('size', String(size))];
      if (a.filename) facts.push(f('filename', a.filename as string));
      let links = 0;
      for (const l of (a.links as { entity_id: string; relation?: string }[] | undefined) ?? []) {
        if (!g.nodes.has(l.entity_id)) continue;
        const r = addFacts(g, { source: eid, target: l.entity_id, relation: l.relation ?? 'describes', confidence: 1, context: '', asserted_by: `artifact:${id}:link` },
          agent(ctx), new Map([[eid, { id: eid, name: a.title } as never]]), self(ctx));
        facts.push(...r.facts);
        links++;
      }
      await write(ctx, facts);
      return { id, entity_id: eid, content_type: a.content_type, title: a.title, domain, size, sha256: sha, deduped: false, links_created: links,
        edges_materialized: links,
        text: `Artifact "${a.title}" created in domain "${domain}".\nid: ${id}\nentity_id: ${eid}\ncontent_type: ${a.content_type}, size: ${size} bytes, sha256: ${sha}\nlinks_created: ${links}, edges_materialized: ${links}` };
    } },
  { name: 'list_artifacts', description: 'List stored documents.', input: obj({ domain: s(), content_type: s(), limit: n(), offset: n() }), access: 'anyone', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const arts = [...g.nodes.values()].filter((x) => x.type === 'artifact' && (a.domain === undefined || x.domain === a.domain)
        && (a.content_type === undefined || x.attrs.get('content_type') === a.content_type))
        .sort((x, y) => ((y.created_at ?? '') < (x.created_at ?? '') ? -1 : 1));
      const page = arts.slice((a.offset as number | undefined) ?? 0, ((a.offset as number | undefined) ?? 0) + ((a.limit as number | undefined) ?? 100));
      return { count: page.length, artifacts: page.map((x) => ({ id: x.attrs.get('artifact_id'), entity_id: x.id, title: x.name, domain: x.domain,
        content_type: x.attrs.get('content_type'), filename: x.attrs.get('filename') ?? null, size: Number(x.attrs.get('size') ?? 0), created_at: x.created_at })) };
    } },
  { name: 'get_artifact', description: 'One stored document, its links, and (for text) its body.', input: obj({ id: s(), include_body: b() }, ['id']),
    access: 'anyone', text: pretty,
    run: async (ctx, a) => {
      const g = await graph(ctx);
      const x = [...g.nodes.values()].find((y) => y.type === 'artifact' && y.attrs.get('artifact_id') === a.id);
      if (!x) throw refuseText(`Artifact ${a.id} not found.`);
      const ct = x.attrs.get('content_type') ?? '';
      const textLike = /^text\//.test(ct) || /^application\/(json|xml|yaml|javascript|typescript)/.test(ct.split(';')[0]!);
      return { id: a.id, entity_id: x.id, content_type: ct, title: x.name, domain: x.domain, filename: x.attrs.get('filename') ?? null,
        size: Number(x.attrs.get('size') ?? 0), sha256: x.attrs.get('sha256'), created_at: x.created_at, updated_at: x.updated_at,
        links: g.out(x.id).map((e) => ({ fact_id: e.fact_id, source: e.source, target: e.target, target_name: g.nodes.get(e.target)!.name, relation: e.relation,
          confidence: e.confidence, context: e.context, asserted_by: e.asserted_by, claimed_by: e.claimed_by })),
        incoming: g.in(x.id).map((e) => ({ fact_id: e.fact_id, source: e.source, source_name: g.nodes.get(e.source)!.name, target: e.target, relation: e.relation,
          confidence: e.confidence, context: e.context, asserted_by: e.asserted_by, claimed_by: e.claimed_by })),
        ...((a.include_body ?? true) && textLike ? { body: x.attrs.get('body') ?? '' } : {}) };
    } },
  // ---- shares: roflenox shares by grant and export; there are no token links ----
  { name: 'list_shares', description: 'Enox share links. A roflenox node has none: it shares by grants and exports.', input: obj({ include_revoked: b() }),
    access: 'anyone', text: pretty, run: async () => ({ count: 0, shares: [] }) },
  { name: 'create_share', description: 'Not offered: share by a grant to an identity, or an export rule (roflenox:grant / roflenox:export facts).',
    input: obj({ name: s(), domains: { type: 'array' }, description: s(), ttl_days: n() }, ['name', 'domains']), access: 'operator', text: plain,
    run: async () => { throw refuseText('Failed to create share: token links are not offered by a roflenox node; publish a roflenox:grant to the reader\'s identity, or a roflenox:export rule, instead.'); } },
  { name: 'revoke_share', description: 'Not offered: a grant ends at its expiry or with a newer grant.', input: obj({ id: s() }, ['id']), access: 'operator', text: plain,
    run: async (_c, a) => { throw refuseText(`Share ${a.id} not found — nothing to revoke.`); } },
];
