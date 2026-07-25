# ENOX Protocol Specification — Draft v0.2

## Changelog

**Draft v0.2** (2026-07-25) — supersedes Draft v0.1.

- Added the **Knowledge Transfer / Shares** layer (§6): the share capsule, the agent-native share manifest, the content digest, cold-discoverability, and revocation-with-receipt. Draft v0.1 specified only a *node* manifest (§5.1.4) and said nothing about sharing a bounded subgraph — this is the largest addition.
- Stated the **four agent-first invariants** as design principles (§1.2).
- Upgraded **`asserted_by`** from optional metadata to a REQUIRED relation field, with the human vs `agent:*` actor distinction and the REST/MCP interface obligations (§2.2, §2.2.1). This supersedes v0.1's treatment of provenance as optional metadata.
- Recorded the honest operational status of **`proof_depth`**: accepted as input but non-load-bearing — not populated or validated as a proof chain by the shipped system (§2.5, rewritten).
- Documented one **per-type molecule** (`type=paper` requires a URL-shaped `source_ref`, §2.1.3) and the **concept-node `description` SHOULD** (§2.1.2).

External co-authored requirements — the Knowledge-Transfer layer, the content-digest specification, and the four invariants — were driven by cold-testing from two independent external agents, **Arête / Praxis** and a peer agent, who entered a live Enox share *by contract only* (URL, no prior briefing) and named agent-to-agent knowledge transfer — not memory replacement — as the protocol's actual value. Their requirements are folded in as first-class spec.

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

### 1.2 The four agent-first invariants

An agent-first knowledge protocol is not a shared brain; it is a **treaty for transporting knowledge** between canons that stay independent. Federation, not fusion: each store keeps its own substrate, and bounded, verifiable slices travel between them. Four invariants govern the whole protocol, and much of the spec below (especially Knowledge Transfer / Shares, §6) is an instance of one of them.

1. **Substrate-independence.** Exporting knowledge MUST NOT require the recipient (or the author) to change their internal substrate. A share is a JSONL slice plus a manifest (§6); a store backed by markdown+git, SQLite, or a graph DB can all emit and consume it. Adoption costs a parser, not a migration. (Static-node materialization, §5.2, is the same principle applied to a whole node.)

2. **Provenance-everywhere.** Every node and every inference leads back to provenance. There is no anonymous knowledge in transit: each assertion carries `asserted_by` (§2.2.1), and a derived `fact_id` never travels without the assertion wrapped around it.

3. **Verify-without-author.** The recipient can verify the content and reconstruct the reasoning fork **without** the author present and **without** shared chat context. The content digest (§6.3) makes this mechanical: a third party recomputes the digest over the canonicalized slice and confirms byte-for-byte that they hold the same version. The negative form is the real test — if meaning can only be reconstructed through familiarity with the author, transfer has *failed*.

4. **Revocation-leaves-an-honest-receipt.** Revoking access controls **future** reads, never past knowledge. Already-read bytes do not become unread. A snapshot + digest is therefore an honest **receipt**: after revocation the guest keeps what they fetched, the share root returns a terminal status (`410`), and the digest still attests *which* version was transferred (§6.5). The protocol never pretends revocation is retroactive.

## 2. Data Model

### 2.1 Entity

An entity is identified by a globally unique URI:

```
enox://{node_host}/{scope}/{owner}/{domain}/{entity_slug}
```

`enox://` is a protocol identifier for deep linking. Transport is resolved to HTTPS or WebSocket by the client.

Example: `enox://enox.dev/personal/alice/cs/knowledge_graph`

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

#### 2.1.2 Node `description` — self-defining nodes (SHOULD)

A **`concept`** node that represents a term or definition **SHOULD** carry a `description` that **defines the entity itself** — what the term *is*. This is guidance (SHOULD), not a hard validator.

The distinction that matters:

- A node's **`description`** holds what the entity **IS** — its standalone definition.
- An edge's **`context`** (§2.2) holds what the specific **RELATION** adds *beyond the triple* — not the definition of either endpoint.

**Failure mode (observed).** In one exported share, 0 of 51 concept nodes carried a `description`: the authoring agent put every definition into the edge `context` instead. The result is a slice where the concept nodes look empty and a term's meaning is smeared across the relations that touch it rather than sitting on the node that names it. Definition-only-in-edge-context hollows out the nodes.

**Why SHOULD, not MUST.** Nodes auto-created as a side effect of writing an assertion (e.g. an `add_assertion` that names a not-yet-existing endpoint) legitimately start **bare**; requiring a description at creation would block honest incremental writing. The obligation is a curation guideline: when a domain is curated, its concept/term nodes SHOULD be given defining descriptions, so the slice is self-explanatory to a cold reader (invariant 3 — a node that defines itself needs no author to interpret it).

#### 2.1.3 Per-type field requirements (targeted molecules)

Perspectives (§3) MAY require additional fields for specific entity types. To illustrate — **without** introducing a grand schema registry — the reference implementation ships exactly one such rule:

- **`type=paper` requires a URL-shaped `source_ref`.** A node asserting a scientific paper is structurally incomplete until it carries a resolvable, URL-shaped `source_ref` (accepted forms: `http(s)://…`, bare `doi.org/…`, bare `arxiv.org/…`, or any string that parses as a URL) pointing at the work itself. A create that omits it, or supplies a non-URL value, is rejected.

This is a **targeted crystallization** — one class-signature made obligatory because it earns its keep — **not** a mandate to pre-declare a schema for every type, and **not** a general perspective-registry mechanism. The rule gates only *new* paper nodes; pre-existing paper nodes without a `source_ref` are grandfathered, and node *updates* are unaffected. Most types stay open-world; a per-type requirement is added only where the completeness check has proven its value.

### 2.2 Relation

A relation is a directed, typed, weighted connection between two entities. Serialized as `_type: "edge"` in JSONL.

**Relation fields (REQUIRED):**

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Source entity URI |
| `to` | string | Target entity URI |
| `rel` | string | Relation type (see §2.3) |
| `fact_id` | string | SHA-256 hash of `{from}\|{rel}\|{to}`. Deterministic — enables cross-node deduplication |
| `asserted_by` | string | Who/what asserts this relation — REQUIRED, no default (see §2.2.1). No anonymous knowledge |

**Relation fields (OPTIONAL):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `confidence` | float | 1.0 | Relation confidence, 0.0–1.0 (see §2.4) |
| `created_by` | string | — | Free-form creator label. Superseded by `asserted_by` (§2.2.1) as the canonical provenance/actor field |
| `proof_depth` | integer | — | Verification chain length (see §2.5) |
| `context` | string | — | Human-readable explanation of why this relation holds |
| `perspective` | string | — | Which perspective produced this relation |
| `status` | string | "extracted" | Epistemic status (see §2.4) |
| `source` | string | — | Source document or process that produced this relation |
| `created_at` | string | — | ISO 8601 timestamp |

**Cross-node relations:** The `from` and `to` fields MAY reference entities on different nodes by using full URIs. Implementations MUST resolve cross-node URIs at query time. The protocol does not prescribe how cross-node relations are stored — this depends on whether the implementation's storage engine supports dangling references.

**Deduplication:** The `fact_id` field is deterministic. Two relations with the same `from`, `rel`, and `to` MUST produce the same `fact_id`. Implementations SHOULD reject duplicates (same `fact_id`) or merge them by keeping the higher-confidence version.

#### 2.2.1 Provenance: `asserted_by` (REQUIRED)

`asserted_by` names who or what asserts a relation. It is **REQUIRED** — an assertion without an asserter is not a valid assertion, and a derived `fact_id` never travels without an assertion wrapped around it. This makes invariant 2 (provenance-everywhere) structurally enforced rather than advisory.

**Actor-type distinction.** `asserted_by` distinguishes human from agent authorship, because the two carry different trust and review semantics:

- **Humans** — a plain identity string, e.g. `alice`.
- **Agents** — an `agent:` prefix, e.g. `agent:praxis`, so machine-generated assertions are never silently attributed to a person.

**Interface obligations:**

- **REST** — the write API MUST require a non-empty `asserted_by`; a write without it is rejected (`400`). There is no default.
- **MCP tools** — writes are performed by agents, not typed by a human, so an omitted `asserted_by` defaults to the connected tool session's **configured agent identity** (`agent:<name>`). Tool-driven writes are thus attributed automatically and are never anonymous.

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

### 2.5 Proof Depth (OPTIONAL, non-load-bearing)

`proof_depth` is an integer originally intended to indicate how many verification steps separate a relation from an axiom or foundational assumption (a shorter chain to a known axiom being more trustworthy than high confidence with an opaque foundation).

**Honest operational status.** In the shipped system `proof_depth` is **parked / non-load-bearing**. It is accepted as write input (defaulting to `0`) but is **not populated or validated as a proof chain** — nothing computes a real verification-chain depth. Whether to retire or develop the field is an open decision.

Therefore:

- `proof_depth` is **OPTIONAL and non-load-bearing**. Consumers MUST NOT treat it as a validated proof-chain depth or a verification guarantee.
- Assertion **strength** is carried by `confidence` (§2.4); assertion **grounding/context** is carried by `source_ref` and the edge `context` field. These are the fields to reason over.
- The field is retained in the relation shape for forward compatibility, documented as parked.

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
  "asserted_by": "alice",
  "perspective": "knowledge",
  "source": "conversation",
  "fact_id": "a3f9b2c4d5e6f7...",
  "status": "extracted",
  "extracted": "2026-03-20",
  "created_at": "2026-03-19T18:41:22.426Z"
}
```

**Required fields:** `_type` (MUST be `"edge"`), `from`, `to`, `rel`, `fact_id`, `asserted_by` (see §2.2.1).

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
  "uri_prefix": "enox://enox.dev/personal/alice",
  "name": "Alice — Personal Knowledge Graph",
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

## 6. Knowledge Transfer / Shares

The node manifest (§5.1.4) describes a *whole node*. This section specifies how a party exposes a **bounded slice** of its graph to an external consumer under revocable, explicitly-limited access — the mechanism external agents named as the protocol's core value: *"give a verifiable subgraph without handing over your house."* A share is the cargo of the treaty in §1.2, not the house.

### 6.1 The share capsule

A **share** is a capsule that exposes a bounded slice of a knowledge graph to an external consumer. It has four defining properties:

- **Bounded subgraph** — a slice (a set of nodes + edges selected by scope, e.g. a set of domains), *not* the whole store. In the reference implementation the slice is all nodes whose domain is in scope, plus every edge whose **both** endpoints are in scope; cross-scope edges are dropped by construction.
- **Share token** — an opaque bearer credential addressing exactly this capsule. Possession of the token is possession of the grant; the token scopes access to the slice and nothing else.
- **Revocable access** — the grantor can revoke at any time. Revocation is forward-only (invariant 4, §6.5): post-revocation reads terminate; bytes already delivered remain with the guest.
- **Explicit limits** — page sizes, traversal depth, and expiry are declared in the manifest (§6.2), not left implicit. A consumer entering "by contract" knows the ceilings up front.

### 6.2 The share manifest (agent-native, content-negotiated)

The share manifest is the machine-readable **contract** for a share: an agent fetches it and knows how to consume the slice without a human-authored README and without a ready-made prompt. It is returned by **content negotiation** on the share root — `Accept: application/json` yields the manifest; a browser `Accept: text/html` yields the human viewer at the same URL. One link serves both audiences. (A "ready prompt" narrative may also be offered for convenience, but it is an imperative from an untrusted source — whoever shared the link — not authoritative contract; only the manifest is.)

The shipped manifest (`protocol: "enox-share"`) has the following shape:

```json
{
  "protocol": "enox-share",
  "schema_version": 1,
  "snapshot": {
    "id": "3f9a…",
    "content_digest": "3f9a…",
    "digest_algorithm": "sha256",
    "canonicalization": { "scheme": "enox-canon-v1", "…": "see §6.3" },
    "digest_scope": {
      "includes": ["nodes", "edges"],
      "node_fields": ["id", "type", "domain", "name", "description", "aliases", "source_ref"],
      "edge_fields": ["fact_id", "source", "target", "relation", "asserted_by", "confidence", "context"],
      "excludes": ["manifest"],
      "note": "Digest covers snapshot content (nodes + edges) only; this manifest is the envelope and is NOT part of the hashed input."
    },
    "taken_at": "2026-07-24T09:00:00Z"
  },
  "slice": {
    "uri": "enox://enox.dev/share/{shareId}",
    "scope": {
      "domains": ["cs", "enox"],
      "node_count": 312,
      "edge_count": 488,
      "nodes_by_type": { "concept": 190, "decision": 40 },
      "edges_by_relation": { "depends_on": 120, "contradicts": 8 }
    }
  },
  "auth": {
    "type": "token",
    "query_param": "token",
    "header": "Authorization: Bearer <token>",
    "note": "token already embedded in the share URL you were given"
  },
  "endpoints": [
    { "rel": "summary",  "method": "GET",  "href": "./api/summary" },
    { "rel": "nodes",    "method": "GET",  "href": "./api/nodes{?q,type,limit}" },
    { "rel": "node",     "method": "GET",  "href": "./api/nodes/{id}" },
    { "rel": "explore",  "method": "GET",  "href": "./api/explore{?name}" },
    { "rel": "traverse", "method": "GET",  "href": "./api/traverse{?from,depth}" },
    { "rel": "mcp",      "method": "POST", "href": "./mcp" },
    { "rel": "manifest", "method": "GET",  "href": "./api" },
    { "rel": "human",    "method": "GET",  "href": ".", "note": "Accept: text/html for the receipt" }
  ],
  "capabilities": ["read", "traverse", "mcp"],
  "limits": { "default_page_size": 100, "max_traverse_depth": 3 },
  "expiry": { "expires_at": null, "revocable": true },
  "errors": {
    "401": "missing or invalid share token",
    "404": "share or resource not found",
    "410": "share revoked or expired"
  }
}
```

Field semantics:

- **`protocol`** / **`schema_version`** — mark the response as an `enox-share` contract and version the *shape* of the manifest itself (bumped when fields are added/removed/renamed, never for underlying data changes — that is what the digest tracks). A consumer pins on `schema_version` to know whether it still understands the response format.
- **`snapshot`** — the point-in-time block: snapshot identity, `taken_at`, and the content-digest fields specified in §6.3. Freezes *which version* of the slice this share exposes.
- **`slice`** — the address of the slice data (`slice.uri`) plus its **scope**: the domains included, node/edge totals, and per-type / per-relation breakdowns.
- **`auth`** — offered in **two forms** so both humans and agents can authenticate: a header-bearer form (`Authorization: Bearer <token>`, machine) and a query-parameter form (`?token=…`, link-shaped). Both address the same grant.
- **`endpoints`** — expressed as **RFC 6570 URI templates**, not baked URLs, so a consumer fills in parameters (`nodes{?q,type,limit}`, `explore{?name}`, `traverse{?from,depth}`, …) mechanically. Consumers enter *by contract* — the templates ARE the API surface. Optional capabilities add endpoints (e.g. a `search` endpoint when the slice carries embeddings, an `artifacts` endpoint when the share includes attached blobs).
- **`capabilities`** — what the slice supports (`read`, `traverse`, `mcp`, and optionally `semantic_search`, `artifacts`).
- **`limits`** — explicit ceilings (default page size, max traversal depth) so consumers self-throttle.
- **`expiry`** — `expires_at` (nullable) and `revocable` (invariant 4). Consumers know the access is time-bounded and withdrawable.
- **`errors`** — a documented, stable set of error codes so an agent handles `401`/`404`/`410` programmatically instead of scraping prose.

### 6.3 Content digest (snapshot verifiability)

**Purpose (invariant 3).** Two parties must be able to **independently prove they read the same version of a slice**. A bare version identifier cannot do this — a recipient cannot recompute it. The snapshot therefore carries a **reproducible content digest with a described canonicalization**, so any third party can recompute the digest over the slice data and confirm byte-for-byte equivalence without trusting the author.

The snapshot block carries:

- **`content_digest`** — the digest value (a SHA-256 hex string) over the canonicalized slice content. This is the verifiable identity of the slice version. The field **`id`** is kept as a back-compat alias of `content_digest` (identical bytes) so existing consumers that read `snapshot.id` keep working.
- **`digest_algorithm`** — the hash algorithm: `sha256`. Declared, not assumed.
- **`canonicalization`** — a described scheme object, tagged **`enox-canon-v1`**, naming the exact deterministic encoding the digest is computed over. It is *described*, not merely performed, so a foreign implementation can reproduce the exact byte sequence and thus the exact digest. Under `enox-canon-v1`:
  - **node** rows use the fields `[id, type, domain, name, description, aliases, source_ref]`, in that exact order; **edge** rows use `[fact_id, source, target, relation, asserted_by, confidence, context]`, in that exact order (`source`/`target` are the edge's endpoint ids — the `from`/`to` of §2.2);
  - the fields of one row are joined by a single `0x01` (U+0001) control character (chosen because it cannot occur in real node/edge text);
  - a null/absent field is encoded as the empty string; `aliases` is the alias list joined by `,`; `confidence` is a decimal string (`String(number)`);
  - rows are **sorted** lexicographically (ascending, by UTF-16 code unit) within their section, and joined by `\n`; the node section and edge section are separated by the literal `\n--\n`.
- **`digest_scope`** — declares **what is hashed**: the slice **nodes + edges** with the fields and ordering above. The **manifest is explicitly excluded** (`excludes: ["manifest"]`): the digest covers *content*, the manifest is the *envelope*. Hashing the envelope into the content would make the digest unstable across equivalent shares of the same data.

The canonicalization description is single-sourced from the snapshot canonicalizer, and the implementation carries an invariant: if the canonicalizer changes, the described scheme MUST change and its `scheme` tag MUST be bumped — a description that has drifted from the code is worse than none.

### 6.4 Cold-discoverability

A share SHOULD be discoverable and consumable by an agent that arrives with **only the URL** and no prior briefing. The reference implementation provides several redundant discovery affordances so no single convention is load-bearing:

- **Content negotiation on the share root** — `Accept: application/json` returns the manifest; `Accept: text/html` returns the human viewer.
- **Manifest aliases** — the same manifest object is reachable at conventional subpaths (`./api` and `./manifest.json`) in addition to content negotiation on the root.
- **RFC 8288 `Link` header** — responses SHOULD carry `Link: <…>; rel="describedby"` pointing at the manifest, the standard "here is my machine description" signal.
- **HTML `<head>` link** — the human viewer page SHOULD embed a `<link rel="describedby">` so the manifest is discoverable even from rendered HTML.
- **`?format=` query override** — an explicit `?format=json` (or `html`) forces the representation when a consumer cannot set an `Accept` header.
- **Clean `404` on unknown subpaths** — paths outside the declared contract return an honest `404` ("not part of this share") rather than a misleading soft response.

The design goal: an agent negotiates the contract from the link alone. In cold testing, external agents closed "almost the entire checklist" of what they needed to consume a share this way.

### 6.5 Revocation with receipt

Revocation is **forward-only** (invariant 4). Revoking a share controls **future** reads, never past knowledge: bytes already delivered to a guest remain with the guest, and the protocol never pretends they become "unread."

- After revocation (or expiry) the share root and its endpoints return a terminal **`410`** status.
- The snapshot + `content_digest` the guest already holds remains an **honest receipt**: it still attests *which* version of the slice was transferred, even though further reads are refused.

This is why verifiability (§6.3) and revocation compose cleanly: a digest computed over content the guest has already fetched is meaningful independently of whether the grantor still serves it.

## 7. Query Interfaces

The protocol does not prescribe a query language. Implementations SHOULD support at least one of:

### 7.1 REST API

```
GET  /api/nodes                 — List entities (filterable by type, domain, search query)
GET  /api/node?id={uri}         — Get single entity by URI
GET  /api/relations             — List relations (filterable by source, target, type)
GET  /api/graph/neighbors?id={uri} — All relations from/to an entity
POST /api/context               — Graph-aware context retrieval (for RAG integration)
```

### 7.2 MCP (Model Context Protocol)

For AI agent integration. Recommended tools: `query_graph`, `add_assertion`, `update_assertion`, `delete_assertion`, `graph_stats`.

### 7.3 Natural Language

LLM translates a question to graph traversal, returns structured answer with confidence. This is the primary interface for most users. Implementation-specific.

## 8. Extraction (Informative)

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

## 9. Comparison with Prior Work

### 9.1 vs Semantic Web (RDF/OWL)

| Aspect | Semantic Web | ENOX |
|--------|-------------|------|
| Extraction | Manual (RDF triples) | Automated (LLM) |
| Schema | Single global ontology required | Per-perspective schemas, no global agreement needed |
| Query interface | SPARQL | Natural language, REST, MCP |
| Participation incentive | Altruistic publishing | Agent SEO — be found by AI agents making decisions |
| Identity | URL (address, mutable) | URI (identity) with content hash option |

### 9.2 vs Mem0 [arXiv:2504.19413]

| Aspect | Mem0 | ENOX |
|--------|------|------|
| Scope | Conversational memory for a single agent | Any knowledge domain, multi-agent |
| Structure | Flat memory + optional graph (+2% accuracy, 2x cost) | Multi-perspective graph as primary data model |
| Confidence | Binary: exists or deleted | Continuous 0.0–1.0 with required provenance (`asserted_by`) |
| Federation | None | URI-based multi-node |
| Conflict handling | DELETE contradictory facts | Explicit `contradicts` edges — disagreement as data |
| Deduplication | Semantic similarity, no explicit algorithm | Three-tier: URI match → embeddings → LLM Judge |

### 9.3 vs GraphRAG [arXiv:2408.08921, 2501.00309]

| Aspect | GraphRAG | ENOX |
|--------|----------|------|
| Graph lifecycle | Built per query or corpus, static | Persistent, growing, federated |
| Retrieval | Subgraph extraction | Budget-constrained induced subgraph with token allocation |
| Dynamic updates | Static graph assumed (acknowledged as open problem) | Federation + live extraction = dynamic by design |
| Multi-perspective | Not supported | First-class: same entity, multiple perspective views |
| Entity resolution | Not discussed in surveys | Three-tier dedup with domain disambiguation |

---

*ENOX Protocol Specification v0.2 — Draft*
*Copyright 2026 Vadim Reshetnikov. Apache 2.0.*
*v0.2 content-digest, Shares, and agent-first invariants co-developed with external agents Arête / Praxis and a peer agent.*
