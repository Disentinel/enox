# ENOX Protocol Specification — Draft v0.1

## 1. Overview

ENOX is a federated protocol for storing, querying, and verifying named relations between entities on the web. Unlike document-centric systems (Google, Wikipedia) or flat knowledge bases (Wikidata), ENOX stores **relations** — directed, typed connections between entities with metadata: confidence, provenance, epistemic status, and perspective-specific fields.

### 1.0 Terminology

- **Entity** — a concept, decision, component, person, or any identifiable object in the graph. Identified by URI.
- **Relation** — a directed, typed connection between two entities, with metadata (confidence, provenance, etc.). The primary data unit of the protocol. Serialized as `_type: "edge"` in JSONL for compatibility with graph tooling.
- **Relation type** — the classification label of a relation (e.g., `extends`, `depends_on`, `contradicts`). The string value in the `rel` field.
- **Perspective** — a named, versioned lens that defines which entity types and relation types it uses, and what validation rules apply.
- **Node** — a federation participant: a server, static file tree, or client that hosts entities and relations.
- **Federation relation** — a relation where `from` and `to` reference entities on different nodes.

### 1.1 Design Principles

1. **Relations-first.** Facts is data. Information is data + metadata. Knowledge is data + metadata + how this data related to other data. Knowledge enables you to generate new data, take decisions and actions.
2. **Perspectives, not ontologies.** No single global schema. Each perspective defines its own entity types, relation types and validation rules over a shared graph. Relations between perspectives is the main value, because it's not obvious knowledge.
3. **Federation by URI, not consensus.** Nodes discover and reference each other by URI prefix. No network-wide consensus required to use network. The more participants connect to each other graphs with federated edges - the closer we are to "generalized knowledge".
4. **You decide on your vision of data.** LLMs extract relations from any text. You may run entity+relation extraction on same document 5 times with different prompts and discover different layers and lenses of knowledge. If you see value in connect your data to others data - you do that, and bring value to everyone.
5. **You decide on data access.** Graphs might be public or private. You can allow to merge your private data to public graphs, but you don't have to do other way around.
6. **Every entity and relation has owner, source and extraction metadata.** If you want your knowledge to be trusted - be transparent how you generated this knowledge.

## 2. Data Model

### 2.1 Entity

An entity is identified by a globally unique URI:

```
enox://{node_host}/{scope}/{owner}/{domain}/{entity_slug}
```

`enox://` is a protocol identifier for deep linking. Transport is resolved to HTTPS or WebSocket by the client.

Example: `enox://enox.dev/personal/vadim_r/cs/knowledge_graph`

**URI components:**

| Component | Description | Constraints |
|-----------|-------------|-------------|
| `node_host` | Federation node that owns this entity | Valid hostname |
| `scope` | Access scope | `private` or `public` |
| `owner` | User or organization identifier | Alphanumeric + underscore |
| `domain` | Knowledge domain | Free-form lowercase tag (cs, ml, psychology, etc.) |
| `entity_slug` | Human-readable identifier | snake_case, ASCII, unique within domain |

The `domain` component disambiguates homonyms: `cs/graph` and `math/graph` are distinct entities. Domains are not enumerated by the protocol — they emerge organically from usage.

**Entity properties (REQUIRED):**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Full URI or `{domain}/{entity_slug}` relative to node |
| `type` | string | Entity classification (see §2.1.1) |
| `name` | string | Human-readable label |
| `domain` | string | Knowledge domain tag |

**Entity properties (OPTIONAL):**

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | 1-2 sentence definition |
| `aliases` | string[] | Alternative names for this entity |
| `source_ref` | string | Provenance reference (document, session, chunk) |
| `created_at` | string | ISO 8601 timestamp |
| `updated_at` | string | ISO 8601 timestamp |

#### 2.1.1 Entity Types

The protocol defines a base set of entity types. Implementations MAY extend this set.

**Knowledge types:** concept, decision, component, pattern, rejected_alternative

**Temporal types:** date, event

**Opinion types:** opinion, preference, value, belief

**Provenance types:** channel, post, person

### 2.2 Relation

A relation is a directed, typed, weighted connection between two entities. Serialized as `_type: "edge"` in JSONL.

**Relation fields (REQUIRED):**

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Source entity URI |
| `to` | string | Target entity URI |
| `rel` | string | Relation type (see §2.3) |
| `fact_id` | string | SHA-256 hash of `{from}\|{rel}\|{to}`. Deterministic — enables cross-node deduplication |

**Relation fields (OPTIONAL):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `confidence` | float | 1.0 | Relation confidence, 0.0–1.0 (see §2.4) |
| `created_by` | string | — | Who created this relation |
| `proof_depth` | integer | — | Verification chain length (see §2.5) |
| `context` | string | — | Human-readable explanation of why this relation holds |
| `perspective` | string | — | Which perspective produced this relation |
| `status` | string | "extracted" | Epistemic status (see §2.4) |
| `source` | string | — | Source document or process that produced this relation |
| `created_at` | string | — | ISO 8601 timestamp |

**Cross-node relations:** The `from` and `to` fields MAY reference entities on different nodes by using full URIs. Implementations MUST resolve cross-node URIs at query time. The protocol does not prescribe how cross-node relations are stored — this depends on whether the implementation's storage engine supports dangling references.

**Deduplication:** The `fact_id` field is deterministic. Two relations with the same `from`, `rel`, and `to` MUST produce the same `fact_id`. Implementations SHOULD reject duplicates (same `fact_id`) or merge them by keeping the higher-confidence version.

### 2.3 Relation Types

The protocol defines relation types grouped by perspective. This is a RECOMMENDED starting set. Implementations MAY introduce new relation types freely.

**Knowledge relations:**

| Relation | Semantics |
|----------|-----------|
| `depends_on` | X requires Y to function or exist |
| `supersedes` | X replaces or makes Y obsolete |
| `implements` | X is a concrete realization of abstract Y |
| `contradicts` | X conflicts with, disproves, or is incompatible with Y |
| `part_of` | X is a component, module, or subset of Y |
| `extends` | X builds upon, expands, or enriches Y |
| `enables` | X makes Y possible or practical |
| `isomorphic_to` | X and Y share deep structural similarity across domains |

**Temporal relations:**

| Relation | Semantics |
|----------|-----------|
| `decided_on` | Decision X was made on date Y |
| `discussed_on` | Concept X was discussed on date Y |
| `changed_on` | X changed or was modified on date Y |
| `created_on` | Artifact X was created on date Y |
| `preceded_by` | Event X happened before event Y |
| `triggered_by` | Event X was caused by event Y |

**Opinion relations:**

| Relation | Semantics |
|----------|-----------|
| `prefers` | Agent X prefers Y over alternatives |
| `distrusts` | Agent X is skeptical of Y |
| `values` | Agent X considers Y important |
| `rejects` | Agent X explicitly rejected approach Y |
| `believes` | Agent X holds belief Y |

**Provenance relations:**

| Relation | Semantics |
|----------|-----------|
| `published_in` | Entity X was published in source Y |
| `authored_by` | Entity X was authored by person Y |
| `mentioned_in` | Entity X was mentioned in document Y |

New relation types are introduced by adding them to a perspective manifest (see §3). There is no protocol-level registry of relation types — vocabulary grows bottom-up from domain needs.

### 2.4 Confidence Model

Confidence is a float in [0.0, 1.0] representing the epistemic status of a relation.

| Range | Status | Meaning |
|-------|--------|---------|
| 0.0–0.3 | `extracted` | LLM pulled from text, not human-verified |
| 0.3–0.6 | `auto-verified` | Multiple independent extractors agree, consistent with existing graph |
| 0.6–0.8 | `human-verified` | 1-2 domain experts confirmed |
| 0.8–0.95 | `strongly-verified` | 5+ independent verifiers from different institutions |
| 0.95–1.0 | `canonical` | Anchor institution asserts + consistent track record over time |

These ranges are RECOMMENDED guidelines. Implementations MAY use different thresholds. The protocol requires only that `confidence` is a float in [0.0, 1.0].

### 2.5 Proof Depth (OPTIONAL)

`proof_depth` is an integer indicating how many verification steps separate this relation from an axiom or foundational assumption.

- A shorter chain to a known axiom is more trustworthy than high confidence with opaque foundation.
- Proof depth is OPTIONAL and meaningful only for perspectives where formal verification applies (scientific, mathematical). Opinion and folk perspectives typically omit it.

## 3. Perspectives

A perspective is a **named, versioned lens over the shared entity graph**.

### 3.1 Definition

A perspective is itself an entity in the graph:

```
enox://enox.dev/perspectives/scientific@1.3
```

A perspective manifest declares:
- **Imported relation types** — from other perspectives (read-only)
- **Own relation types** — new relations specific to this perspective
- **Validation rules** — what makes a relation valid under this perspective
- **Traversal filters** — which relations are visible through this lens

### 3.2 Composition Modes

1. **Aliasing** — same entity, different names per perspective. `compound` (chemistry) = `drug` (medicine) = `substance` (law).
2. **Relation inheritance** — a perspective imports relation types from another. `ml_research` inherits `authored_by` from `scientific`, adds `outperforms`.
3. **Isolated subgraph** — private edges invisible to other perspectives.

### 3.3 Cross-Perspective Queries

```
TRAVERSE entity:X
  WITH PERSPECTIVES [scientific, ml_research]
  WHERE scientific.confidence > 0.8
  AND ml_research.experiment_count > 50
```

This is NOT merge — it is a join with explicit conditions from each perspective. The query syntax above is illustrative; implementations MAY use any query language.

### 3.4 Governance

It is planned to establish the Enox Foundation to build and support anchor public hubs for common knowledge domains and evolve the protocol and toolset. We expect domain-expert institutions (universities, journals) to maintain their own anchor nodes as they find this protocol useful.

The protocol does not limit what you can host. Community will decide what works best.

## 4. Federation

### 4.1 Node Classification

**By trust level:**

| Type | Operator | Role |
|------|----------|------|
| Anchor | Universities, journals, regulators | Canonical source, high trust, KYC required |
| Participant | Companies, researchers | Stores subgraphs, growing trust, private knowledge hubs with optional paid access |
| Observer | Self-hosted / Read-only | Caches and replicates, zero barrier to entry |

**By capability:**

| Type | Description |
|------|-------------|
| Smart node | Serves requests, performs federated search, provides API |
| Static node | Graph materialized as files, served by HTTP (S3, GCS, static hosting) |
| Client node | Performs traversal over accessible federation region, no persistent storage |

### 4.2 Discovery

Minimum participation requirement: one file at a well-known endpoint.

```
GET /.well-known/enox.json
```

Returns node metadata: URI prefix, supported perspectives, peer list, capabilities.

The protocol does not prescribe a specific discovery mechanism. Implementations MAY use:
- Manual peer configuration
- Peer-to-peer discovery
- Centralized registry (like DNS providers)

A public registry at `registry.enox.dev` is planned but its usage is OPTIONAL.

### 4.3 Cross-Node References

Relations MAY reference entities on any node by full URI. The protocol does not dictate how cross-node relations are stored — this depends on the implementation's storage engine supporting dangling references or not. Resolution happens at query time: the federation layer resolves URIs to the appropriate node.

### 4.4 Replication

Nodes MAY cache entities and relations from peers to improve throughput. Core requirement: ownership metadata and provenance MUST remain intact and unmodified in replicated data.

### 4.5 Consistency

Implementation-dependent. The protocol targets eventual consistency. Implementations SHOULD prioritize fast propagation of epistemic status changes (e.g., `supported` → `refuted`).

## 5. Serialization Format

This section defines the wire format for data interchange between nodes. This is the core normative content of the protocol.

### 5.1 JSONL (Primary Interchange Format)

ENOX data is serialized as newline-delimited JSON (JSONL). Each line is a self-contained JSON object with a `_type` discriminator.

#### 5.1.1 Entity Record

```json
{
  "_type": "node",
  "id": "cs/knowledge_graph",
  "node_type": "concept",
  "label": "Knowledge Graph",
  "description": "A graph-based knowledge representation where entities are nodes and relations are typed, weighted edges with provenance metadata.",
  "aliases": ["KG", "knowledge base graph"],
  "domain": "cs",
  "source_ref": "session:abc123/chunk:3",
  "created_at": "2026-03-19T18:41:22.426Z",
  "updated_at": "2026-03-19T18:41:22.426Z"
}
```

**Required fields:** `_type` (MUST be `"node"`), `id`, `node_type`, `label`, `domain`.

**The `id` field** contains the entity's path relative to the node: `{domain}/{entity_slug}`. The full URI is constructed by prepending the node's URI prefix. When referencing entities on other nodes, the full URI is used.

#### 5.1.2 Relation Record

```json
{
  "_type": "edge",
  "from": "cs/knowledge_graph",
  "to": "cs/semantic_web",
  "rel": "extends",
  "confidence": 0.85,
  "context": "Knowledge graphs build on Semantic Web ideas but with LLM-powered extraction instead of manual RDF authoring.",
  "created_by": "vadim_r",
  "perspective": "knowledge",
  "proof_depth": 2,
  "source": "conversation",
  "fact_id": "a3f9b2c4d5e6f7...",
  "status": "extracted",
  "extracted": "2026-03-20",
  "created_at": "2026-03-19T18:41:22.426Z"
}
```

**Required fields:** `_type` (MUST be `"edge"`), `from`, `to`, `rel`, `fact_id`.

**The `from` and `to` fields** contain entity paths relative to the current node, OR full URIs for cross-node references.

**The `fact_id` field** MUST equal `SHA-256("{from}|{rel}|{to}")` where `from` and `to` are the values as stored in the record. This ensures deterministic deduplication.

#### 5.1.3 Perspective Record

```json
{
  "_type": "perspective",
  "id": "scientific@1.3",
  "name": "Scientific",
  "version": "1.3",
  "extends": ["base@1.0"],
  "entity_types": ["concept", "component", "pattern"],
  "relation_types": ["depends_on", "supersedes", "implements", "contradicts", "extends", "enables"],
  "validation_rules": {
    "min_confidence_for_verified": 0.6,
    "require_proof_depth": true,
    "require_source": true
  }
}
```

**Required fields:** `_type` (MUST be `"perspective"`), `id`, `name`, `version`, `relation_types`.

Perspective records define which entity types and relation types belong to a perspective, and optionally specify validation rules and inheritance.

#### 5.1.4 Node Manifest

```json
{
  "_type": "manifest",
  "uri_prefix": "enox://enox.dev/personal/vadim_r",
  "name": "Vadim Reshetnikov — Personal Knowledge Graph",
  "scope": "private",
  "node_count": 7783,
  "edge_count": 6495,
  "perspectives": ["knowledge@1.0", "temporal@1.0", "opinions@1.0"],
  "domains": ["cs", "enox", "ml", "psychology", "business"],
  "peers": [
    {"prefix": "enox://enox.dev/source", "url": "https://source.enox.dev"},
    {"prefix": "enox://enox.dev/source/arxiv", "url": "https://arxiv.enox.dev"}
  ],
  "schema_version": "0.1",
  "last_updated": "2026-03-20T08:42:26Z"
}
```

**Required fields:** `_type` (MUST be `"manifest"`), `uri_prefix`, `name`, `schema_version`.

The manifest is served at `/.well-known/enox.json` and included as the first record in full graph dumps.

### 5.2 File Materialization (Static Node)

A static node is a directory tree served over HTTP. Each entity is a self-contained file. Each domain has a dump. The root has a full dump.

```
{node_host}/{scope}/{owner}/
├── manifest.json               ← node manifest (§5.1.4)
├── graph.jsonl.gz              ← full dump (all entities + relations)
├── {domain}/
│   ├── {entity_slug}.json      ← single entity + all its relations + embedding vector
│   ├── graph.jsonl.gz          ← domain dump (all entities in domain + cross-domain relations)
│   └── manifest.json           ← domain stats: entity count, relation count, cross-domain relation count
```

**Full dump:** All entity and relation records for the entire node, gzipped JSONL. First record MUST be the node manifest.

**Domain dump:** All entities within one domain + all relations where at least one endpoint is in this domain. Cross-domain relations appear in dumps for both domains.

**Entity file:** JSON object containing the entity record, all relations (incoming and outgoing), and optionally the entity's embedding vector.

## 6. Query Interfaces

The protocol does not prescribe a query language. Implementations SHOULD support at least one of:

### 6.1 REST API

```
GET  /api/nodes                 — List entities (filterable by type, domain, search query)
GET  /api/node?id={uri}         — Get single entity by URI
GET  /api/relations             — List relations (filterable by source, target, type)
GET  /api/graph/neighbors?id={uri} — All relations from/to an entity
POST /api/context               — Graph-aware context retrieval (for RAG integration)
```

### 6.2 MCP (Model Context Protocol)

For AI agent integration. Recommended tools: `query_graph`, `add_assertion`, `update_assertion`, `delete_assertion`, `graph_stats`.

### 6.3 Natural Language

LLM translates a question to graph traversal, returns structured answer with confidence. This is the primary interface for most users. Implementation-specific.

## 7. Extraction (Informative)

This section is informative, not normative. The protocol does not prescribe how data is extracted — only the format it must be in (§5).

The reference implementation provides an example pipeline:

```
Source text → Chunking → LLM extraction → JSONL → URI-based dedup → Load → Post-load dedup sweep
```

Key design decision: extraction is deliberately context-free (no knowledge of existing graph). Deduplication is a separate post-load step that operates across the entire federation.

Multi-perspective extraction: the same source text is processed with different prompts to produce different perspective layers (knowledge, temporal, opinions).

Deduplication is three-tier:
1. **Exact URI match** — deterministic, free, at load time
2. **Embedding similarity** — local vector model, finds fuzzy candidates
3. **LLM Judge** — decides SAME / ALIAS / DIFFERENT for ambiguous pairs

## 8. Comparison with Prior Work

### 8.1 vs Semantic Web (RDF/OWL)

| Aspect | Semantic Web | ENOX |
|--------|-------------|------|
| Extraction | Manual (RDF triples) | Automated (LLM) |
| Schema | Single global ontology required | Per-perspective schemas, no global agreement needed |
| Query interface | SPARQL | Natural language, REST, MCP |
| Participation incentive | Altruistic publishing | Agent SEO — be found by AI agents making decisions |
| Identity | URL (address, mutable) | URI (identity) with content hash option |

### 8.2 vs Mem0 [arXiv:2504.19413]

| Aspect | Mem0 | ENOX |
|--------|------|------|
| Scope | Conversational memory for a single agent | Any knowledge domain, multi-agent |
| Structure | Flat memory + optional graph (+2% accuracy, 2x cost) | Multi-perspective graph as primary data model |
| Confidence | Binary: exists or deleted | Continuous 0.0–1.0 + proof_depth |
| Federation | None | URI-based multi-node |
| Conflict handling | DELETE contradictory facts | Explicit `contradicts` edges — disagreement as data |
| Deduplication | Semantic similarity, no explicit algorithm | Three-tier: URI match → embeddings → LLM Judge |

### 8.3 vs GraphRAG [arXiv:2408.08921, 2501.00309]

| Aspect | GraphRAG | ENOX |
|--------|----------|------|
| Graph lifecycle | Built per query or corpus, static | Persistent, growing, federated |
| Retrieval | Subgraph extraction | Budget-constrained induced subgraph with token allocation |
| Dynamic updates | Static graph assumed (acknowledged as open problem) | Federation + live extraction = dynamic by design |
| Multi-perspective | Not supported | First-class: same entity, multiple perspective views |
| Entity resolution | Not discussed in surveys | Three-tier dedup with domain disambiguation |

---

*ENOX Protocol Specification v0.1 — Draft*
*Copyright 2026 Vadim Reshetnikov. Apache 2.0.*
