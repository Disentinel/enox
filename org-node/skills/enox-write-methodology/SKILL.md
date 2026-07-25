---
name: enox-write-methodology
description: >
  Methodology for writing knowledge into an Enox smart node — facts, decisions,
  observations, reasoning chains. Use this WHENEVER recording anything to Enox, and
  whenever someone says "remember this", "record this decision", or asks how to structure
  something for the knowledge graph. Defines context hygiene, atomic storage with molecular
  validation, structural rules, perspective handling, and session anchoring that apply to
  ALL Enox writes. Read it before any add_assertion / remember / batch_assertions call.
user_invocable: true
version: 1.0.0
---

# Enox Write Methodology

The rules that apply to every write into an Enox smart node. The companion
`enox-team-how-to-write` skill builds on this for teams sharing one node.

## The edge model (canonical)

An **assertion** is the primary object. A bare fact (triple) is only a lookup key.

- `fact_id = SHA256(source + relation + target)` — derived only, never primary. It
  never travels without an assertion wrapped around it.
- Every assertion MUST carry `asserted_by`. No anonymous knowledge. On a
  token-authenticated node, `asserted_by` is the authenticated user — let the
  server set it; do not spoof another identity.
- Edge shape: `(source, target, relation, perspective, confidence, proof_depth)`.
- The graph is queryable from any client; the server stays simple. Temporality is
  optional metadata on edges, not a structural requirement.

## Context hygiene

**Context = what the structure does not say.** The triple captures the relation;
the `context` field captures everything a future reader needs that the triple alone
cannot convey — why this was asserted, what was true at the time, what it depends on
that isn't an edge yet. Write context for a reader who has none. **Do not restate the
triple in prose.** The context string is also what semantic search indexes, so make
it specific (names, numbers, conditions), not generic.

## Atomic storage, molecular validation

Two distinct levels — and the validation level is the one people skip.

- **Atomic storage.** Store one fact per assertion. Do not pack a paragraph of
  claims into a single edge. If you're tempted to write "X does A and B and depends
  on C," that's three edges.
- **Molecular validation.** A fact is never validated in isolation — it is validated
  against its **neighborhood** (the connected assertions around it). Before
  committing, run the molecular check:
  1. **Consistency** — does the new edge contradict an existing edge in the local
     subgraph? If yes, surface the contradiction; do not silently overwrite. Two
     contradicting assertions can coexist *if* they carry different `asserted_by` or
     `perspective` — that is signal, not error. Record it with `contradicts`.
  2. **Completeness** — does the entity the edge attaches to have the obligatory
     edges its kind requires? A `decision` node with no `because` /
     `rejected_alternative` edge is structurally incomplete. Mark the gap as a
     known-unknown rather than pretending the molecule is whole.
  3. **Redundancy** — is this edge already implied by an existing edge (same
     `fact_id`, or derivable by one traversal hop)? If so, raise
     confidence/`proof_depth` on the existing one instead of duplicating.
  4. **Provenance depth** — set `proof_depth` honestly: 0 = asserted, 1 = backed by
     one source, higher = corroborated chain. Do not inflate.

Atomic write + molecular validate is the core discipline. Atoms keep the graph
queryable; molecular validation keeps it true.

## Resolve targets to existing nodes (no duplicates)

Before writing, search for the entities you're about to reference
(`query_graph` / `semantic_search` / `explore`) and reuse the **exact existing
name** so the new edge attaches to the canonical node. Only create a new node for a
genuinely-absent entity, and give it a clear name and a sensible `type`. Duplicate
near-identical nodes ("Auth Service" vs "auth-service") are the main way a shared
graph rots.

## Schemaless, but consistent

Node `type` and `relation` are free strings on this node — you are not locked into a
fixed ontology. Use the server's **suggested** types where they fit (they appear in
the tool descriptions) and only mint a new type when the suggested ones genuinely
don't. Common suggested values:

- **Node types:** `concept`, `decision`, `component`, `pattern`,
  `rejected_alternative`, `event`, `effort`, `task`, `session`, `intent`.
- **Relations:** `depends_on`, `supersedes`, `implements`, `contradicts`,
  `part_of`, `extends`, `enables`, `triggered_by`, `blocks`, `references`.

Pick one spelling per concept and keep the whole team on it.

## Perspective is first-class

`perspective` is both a **validation schema** and a **traversal filter**. The same
source–relation–target can be asserted under different perspectives with different
confidence and validation requirements. Never collapse perspectives into a single
"objective" edge — the disagreement between perspectives is data.

## Session anchoring

Anchor a batch of related assertions to a session node
(`session:YYYY-MM-DD-topic`). This makes provenance traceable ("where did this come
from") and lets the reasoning be re-opened later. End a substantive session by
recording a short `about` edge from the session to the concept it produced.

## When NOT to write

- Don't record transient chatter, restated context, or anything derivable by one
  traversal hop.
- Don't record decisions made under pressure as if settled — tag them provisional,
  to be confirmed later.
- Don't invent `asserted_by` to satisfy the schema. If you don't know who asserts
  it, you can't write it.

## Verification

After a batch, `explore` (or `query_graph`) the touched entities: the new edges
should be present, point to canonical (non-duplicate) targets, and read coherently
against their neighborhood. If `semantic_search` on the topic doesn't surface them,
the context strings were too thin — improve them.
