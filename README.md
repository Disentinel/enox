# ENOX — Federated Knowledge Protocol

**Named relations between verified facts. The semantic layer the web always needed.**

Enox is an open federated protocol that stores named, verified relations between any two entities on the web — making the structure of human knowledge as navigable as the web made documents.

## Why now?

The Semantic Web (RDF, OWL, SPARQL) had the right idea in 2001 but failed for three reasons:
- **Extraction was manual** — nobody writes RDF triples by hand
- **Query interface was dead** — SPARQL is a language nobody wants to learn
- **No economic motive** — why publish a structured ontology for free?

In 2024-2026, all three barriers disappeared simultaneously:

| Barrier (2001) | Solution (2024) |
|----------------|-----------------|
| Manual extraction | LLMs extract relations from any text automatically |
| Dead query interface | Natural language via MCP / chat |
| No motive to participate | Agent SEO: be found by AI agents making decisions |

## Core Insight

**Edges, not nodes.** Knowledge is not made of facts — it is made of *relations between facts*. The entity "aspirin" exists independently of what we think about it. But the edge `aspirin → reduces_risk → myocardial_infarction` has a confidence value, a provenance chain, conditions of applicability, and an epistemic status. That is what Enox stores.

## What's in this repo

### Reference Implementation: Smart Node

A working personal knowledge graph node with federation support.

```
smart-node/
├── src/              — Express + KuzuDB + MCP server (SSE + StreamableHTTP)
├── scripts/          — Extraction pipeline, batch processing, dedup
├── Dockerfile        — ARM-ready container
└── src/public/       — D3.js force-directed graph visualizer
```

**Features:**
- **Domain-aware URI identity**: `enox://enox.dev/personal/{owner}/{domain}/{entity}` — deterministic dedup, federation-ready
- **Multi-perspective extraction**: knowledge, temporal, opinions — three views of the same conversation
- **Federation**: multiple nodes with cross-reference by URI, peer discovery
- **Graph-aware RAG**: induced subgraph from user prompt → budget-constrained context injection
- **Local embeddings**: all-MiniLM-L6-v2 via ONNX Runtime, background indexing
- **Live UI**: force-directed graph with filters, focus/scope, free-text ingest
- **MCP server**: 5 tools (query_graph, add_assertion, update/delete, graph_stats)

### Quick Start

```bash
cd smart-node
npm install
npm run dev     # starts on :3700

# Open http://localhost:3700 for the graph UI
```

### Federation (two nodes)

```bash
# Node 1: Personal graph
NODE_NAME=personal NODE_URI_PREFIX=enox://enox.dev/personal/your_name PORT=3700 npm run dev

# Node 2: Public sources
NODE_NAME=sources NODE_URI_PREFIX=enox://enox.dev/source PORT=3701 npm run dev
```

### Extraction Pipeline

```bash
# Extract knowledge from a text file
./scripts/extract.sh conversation.txt output.enox.jsonl

# With perspective
./scripts/extract.sh conversation.txt output.enox.jsonl --perspective opinions

# Load into graph
python3 scripts/load.py output.enox.jsonl http://localhost:3700

# Batch: process all sessions
./scripts/batch-extract.sh --max-parallel 3
```

### Edge Format (JSONL)

```json
{"_type": "node", "id": "cs/knowledge_graph", "node_type": "concept", "label": "Knowledge Graph", "description": "A graph-based knowledge representation where entities are nodes and relations are typed edges with metadata.", "aliases": ["KG"], "domain": "cs"}

{"_type": "edge", "from": "cs/knowledge_graph", "rel": "extends", "to": "cs/semantic_web", "confidence": 0.85, "context": "Knowledge graphs build on Semantic Web ideas but with LLM-powered extraction instead of manual RDF authoring.", "source": "conversation", "extracted": "2026-03-19", "status": "extracted"}
```

### Graph-Aware RAG vs Naive RAG

The context hook (`scripts/graph-context.py`) demonstrates why graph structure beats flat vector search:

**Naive RAG (vector similarity):**
```
Query: "how are perspectives related to federation?"
→ Top-5 by embedding similarity:
  1. "Perspective Schema Versioning" (sim=0.82)
  2. "Federated Perspective Schema" (sim=0.79)
  3. "Open Graph Federation" (sim=0.77)
  4. "Three-Tier Perspective Hierarchy" (sim=0.75)
  5. "Perspective Manifest" (sim=0.74)

Result: 5 loosely related concepts. No structure. No "why".
```

**Graph-Aware RAG (induced subgraph):**
```
Query: "how are perspectives related to federation?"
→ Seed entities: [Perspective as Lens, Open Graph Federation]
→ 1-hop expansion → induced subgraph:

  Perspective as Lens --[part_of]--> Enox Protocol
  Open Graph Federation --[part_of]--> Enox Protocol
  Perspective Manifest --[enables]--> Cross-Perspective Traversal
  Cross-Perspective Traversal --[depends_on]--> Federation
  Semantic Web --[contradicts]--> Single Global Ontology (rejected)
  Federated Schema --[supersedes]--> Single Global Ontology

Result: A connected subgraph showing *how* perspectives enable federation
and *why* — because they replace the single-ontology approach that killed
Semantic Web. Structure, not similarity.
```

## Protocol Overview

### Three Identifier Types

| Identifier | Used for | Stability |
|-----------|----------|-----------|
| DOI / ISBN / ORCID | Academic papers, books, researchers | Permanent |
| IPFS content hash | Web pages, documents without DOI | Permanent, decentralized |
| `enox:concept/X` | Abstract concepts | Internal, resolves to subgraph |

### Node Types in Federation

| Node type | Who runs it | Role |
|-----------|-------------|------|
| Anchor node | Universities, journals | Canonical source, high trust, KYC |
| Participant node | Companies, researchers | Stores subgraphs, trust grows with track record |
| Observer node | Anyone | Caches and replicates, zero barrier |
| Managed node | Enox Infrastructure | Hosted participant, pay per compute |

### Verification (Confidence Levels)

| Confidence | Status | Meaning |
|-----------|--------|---------|
| 0.0–0.3 | extracted | LLM pulled from text, not verified |
| 0.3–0.6 | auto-verified | Multiple LLMs agree, consistent with graph |
| 0.6–0.8 | human-verified | 1-2 domain experts confirmed |
| 0.8–0.95 | strongly-verified | 5+ independent verifiers |
| 0.95–1.0 | canonical | Anchor institution + consistent track record |

## Known Limitations (honest assessment)

This is a working proof of concept, not production software. Here's what's broken:

### Extraction Quality
- Sonnet confidence scores are **arbitrary** — 0.9 means "Sonnet wrote 0.9", not "90% sure"
- No ground truth verification. Graph could be 30% noise.
- Entity descriptions are biased to first-mention context, not canonical definitions.

### Dedup
- Exact URI match works. Everything else doesn't (yet).
- Russian/English synonyms miss entirely ("Ловушка компетентности" ≠ "Competence Trap")
- LLM Judge written but not battle-tested at scale.

### Chunking
- 4K chars per chunk cuts mid-thought. A reasoning chain `A → B → C → conclusion D` split across chunks loses the causal link between A and D.

### Database
- KuzuDB v0.11.3 is **archived** — no future updates. Good enough for <50K nodes.
- No vector search, no full-text index. Embeddings stored as separate JSON file.
- Migration to DuckDB or Postgres needed for production scale.

### Federation
- Two `fetch()` calls to localhost. No auth, no TLS, no discovery protocol.
- Real federation needs BGP-style routing, certificate pinning, consistency model.

### UI
- D3.js force layout unusable above ~2K nodes.
- No layout persistence, no undo, no diff view.

### RAG
- Russian stemming is 5 suffix rules. Embedding fallback is the similarity search we claimed to replace.
- "Induced subgraph" is 1-hop, not true pathfinding. Multi-hop requires explicit MCP tool call.

**All of these are engineering problems, not architectural ones.** The URI scheme, perspective model, federation via peers, and extraction pipeline are architecturally sound. The walls are rough, but the foundation is right.

## Economics

```
Extraction cost: ~$0.02 per session (Sonnet, ~30K chars)
Embedding cost: ~$0.00 (local ONNX, no API calls)
Storage: negligible (S3: $0.05/month per million nodes)
```

## Roadmap

1. **$50 experiment** — 500 arxiv CS papers, 5 relation archetypes, validate graph finds invisible connections
2. **MCP server + REST API** — CS arxiv domain, opt-in feedback, first paying users
3. **Protocol spec** — Second node, open-source worker, federation, Foundation incorporation

## License

ODbL (Open Database License). Facts are not copyrightable. The labor of assembly is protected. Derived datasets must remain open. Services built on top can be commercial.

---

*Concept Manifesto v0.2 | March 2026*
*enox.earth | enox.dev*

*Built on the shoulders of OWL, RDF, and Semantic Web. Arrived twenty years later, when the infrastructure finally caught up.*
