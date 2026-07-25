# ENOX — Federated Knowledge-Graph Protocol

**Relations between facts as the primary unit — the semantic layer the web always needed.**

Enox is an open, federated knowledge-graph **protocol**. Its atom is not the document but
the **relation**: a directed edge `(source) --[relation]--> (target)` carrying a
**confidence** (how strongly the claim is held, 0–1 — not a boolean), **provenance**
(`asserted_by` — who asserted it and in what context, so a human note, an agent inference,
and an imported paper stay distinguishable and auditable), and **perspective** (the lens a
claim was extracted under, so competing or domain-specific views coexist instead of
overwriting each other). It is **agent-native** — every node speaks both **MCP** and
**REST**, so an agent reads and writes the graph as tools. And knowledge **transfer** is
first-class: you hand someone a *slice* of your graph as a **revocable share capsule** with
a reproducible **content digest**, a live queryable endpoint rather than a dead export.

Contrast with what most "knowledge bases" do:

| | Document store / vector DB | Flat wiki / KB | **Enox** |
|---|---|---|---|
| Primary unit | document / chunk | page | **relation (edge)** |
| "Is it true?" | n/a (retrieval only) | implicit | **explicit confidence** |
| Who said it | lost in the blob | page history | **per-edge provenance (`asserted_by`)** |
| Conflicting views | collide / dedup away | last-write-wins | **coexist as perspectives** |
| Cross-owner links | — | — | **federated URIs** |
| Handing knowledge on | export a dead dump | copy a page | **revocable live share + content digest** |

## Start here

Want to run Enox? Self-host the **[`personal-node/`](personal-node/)** — the polished,
full-featured single-owner node — and you're up in one command:

```bash
cd personal-node && docker compose up
```

The node comes up on `http://localhost:3700` with a web UI at `/`, a REST API under
`/api`, and an MCP endpoint at `/mcp`. See **[`personal-node/README.md`](personal-node/README.md)**
for configuration, share/transfer, and MCP setup.

## Repository layout

| Path | What it is |
|---|---|
| **[`personal-node/`](personal-node/README.md)** | **Recommended.** The polished, full-featured **single-owner** node: shares & artifacts, knowledge transfer via revocable share capsules with a content-digest manifest, MCP tools with session renewal, a React graph/wiki UI, REST + MCP. Ships with its own `docker-compose.yml` — `cd personal-node && docker compose up`. **Start here to self-host.** |
| [`org-node/`](org-node/README.md) | Multi-tenant node for teams (per-user bearer tokens, isolation, per-user `asserted_by` attribution, admin console). **WIP: being rebuilt on a shared core; it currently lacks the share / artifact transfer layer.** Use `personal-node/` unless you specifically need multi-tenant auth today. |
| [`PROTOCOL.md`](PROTOCOL.md) | The normative protocol specification — **Draft v0.2**. Entities & URI scheme, relations, perspectives, federation, and shares. |
| [`schema.md`](schema.md) | The JSONL edge/node interchange format at a glance. |
| [`ROADMAP.md`](ROADMAP.md) | Where the project is headed. |
| [`LICENSE`](LICENSE) | Apache 2.0. |

## Why now?

The Semantic Web (RDF, OWL, SPARQL) had the right idea in 2001 but failed for three
reasons — all of which fell away in 2024–2026:

| Barrier (2001) | Solution (2024) |
|----------------|-----------------|
| Manual extraction — nobody writes RDF triples by hand | LLMs extract relations from any text automatically |
| Dead query interface — SPARQL is a language nobody wants to learn | Natural language via MCP / chat |
| No motive to participate — why publish a structured ontology for free? | Agent-native discovery: be found by AI agents making decisions |

## Core insight

**Edges, not nodes.** Knowledge is not made of facts — it is made of *relations between
facts*. The entity "aspirin" exists independently of what we think about it. But the edge
`aspirin --[reduces_risk]--> myocardial_infarction` has a confidence value, a provenance
chain, conditions of applicability, and an epistemic status. That is what Enox stores.

Because entities are addressed by URI
(`enox://example.org/graph/main/{domain}/{slug}`), nodes can reference each other **across
owners** — that is the *federated* part. A URI minted on one node resolves and links from
another, without a single global ontology.

## Interchange format (JSONL)

Nodes and edges serialize one-per-line for import/export and static materialization:

```json
{"_type": "node", "id": "cs/knowledge_graph", "node_type": "concept", "label": "Knowledge Graph", "description": "A graph where entities are nodes and relations are typed edges with metadata.", "aliases": ["KG"], "domain": "cs"}
{"_type": "edge", "from": "cs/knowledge_graph", "rel": "extends", "to": "cs/semantic_web", "confidence": 0.85, "context": "Knowledge graphs build on Semantic Web ideas but with LLM-powered extraction instead of manual RDF authoring.", "asserted_by": "agent", "status": "extracted"}
```

See [`schema.md`](schema.md) for the full field list and [`PROTOCOL.md`](PROTOCOL.md) for
the normative definitions.

## Knowledge transfer via share capsules

Instead of exporting a dead document, a `personal-node/` owner hands over a **live,
read-only slice** of the graph — selected by domain — with its own token, landing page,
and MCP endpoint, so the recipient can query the slice without touching the rest of the
graph. Each capsule carries a reproducible **content digest** so both sides can verify they
hold the same knowledge, and it is **revocable** at any time. See
[`personal-node/README.md`](personal-node/README.md) for the share/transfer walkthrough and
[`PROTOCOL.md`](PROTOCOL.md) for the spec.

## Verification (confidence levels)

Confidence is a first-class, graduated signal — not a true/false flag:

| Confidence | Status | Meaning |
|-----------|--------|---------|
| 0.0–0.3 | extracted | LLM pulled from text, not verified |
| 0.3–0.6 | auto-verified | Multiple LLMs agree, consistent with the graph |
| 0.6–0.8 | human-verified | 1–2 domain experts confirmed |
| 0.8–0.95 | strongly-verified | Multiple independent verifiers |
| 0.95–1.0 | canonical | Anchor institution + consistent track record |

## Status (honest assessment)

This is an early, working protocol implementation, not turnkey production software:

- **Extraction quality** — LLM confidence scores are indicative, not calibrated against
  ground truth; entity descriptions can be biased toward first-mention context.
- **Dedup** — exact URI match is reliable; cross-language synonyms and fuzzy merges are
  best-effort (an optional LLM link-judge assists but is not battle-tested at scale).
- **Federation** — the URI scheme and per-node references are in place; hardened discovery,
  auth, and consistency across many nodes are still maturing.
- **`org-node/`** — multi-tenant node is **WIP**: being rebuilt on a shared core and does
  not yet have the share/artifact transfer layer that `personal-node/` ships.

The URI scheme, perspective model, provenance/confidence design, and share-based transfer
are the architectural core — and they are the parts that are solid.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

---

*Protocol Draft v0.2 · 2026. Built on the shoulders of OWL, RDF, and the Semantic Web —
arrived twenty years later, when the infrastructure finally caught up.*
