# Enox Smart Node — TODO

## Completed
- [x] Smart Node MVP (KuzuDB + Express + MCP SSE/HTTP)
- [x] CRUD API with domain-aware URI IDs
- [x] D3.js graph visualizer with filters, panel, pinning, collapsible sections
- [x] Knowledge extraction pipeline (extract.sh + Sonnet)
- [x] Three perspectives: knowledge, temporal, opinions
- [x] `--perspective` flag in extract.sh
- [x] URI-based dedup on load (exact match for nodes AND edges via fact_id)
- [x] LLM Judge for fuzzy dedup (dedup-judge.py)
- [x] Cross-session entity dedup (auto-merged via URI)
- [x] Session source entities + discussed_on links (zero orphans)
- [x] Free-text ingest from UI (Shift+Enter, Sonnet extraction, live graph update)
- [x] Focus/scope filtering by source node
- [x] Opinion prompt fix: every opinion MUST link to subject entity
- [x] Provenance types: channel, post, person + published_in, authored_by, mentioned_in
- [x] Click-to-copy entity URI
- [x] Local embeddings (all-MiniLM-L6-v2 via ONNX, background worker)
- [x] Periodic backup snapshots (JSONL every 15 min, shutdown snapshot, rotation)
- [x] Embedding-powered RAG fallback (Russian/fuzzy queries work)
- [x] Graph-aware context hook (UserPromptSubmit → induced subgraph → system-reminder)

## Next priorities
1. **Continuous KDL hook** — `assistant_response` hook that triggers extraction every N messages
2. **source_ref field** — provenance (session_id + chunk) on entities for temporal enrichment
3. **Cross-perspective linking** — temporal/opinions entities should reference existing knowledge entities by URI
4. **Docker deployment** — Dockerfile ready, deploy to Hetzner ARM

## Future (when graph > 1000 nodes)
5. **Entity description enrichment** — two-field model:
   - `description` = canonical definition (what it IS objectively, from world knowledge)
   - `context_notes` = how/why it was mentioned (from extraction context)
   - Background enrichment: new entities get canonical description via "define {name} in {domain}" prompt
   - Periodic sweep: entities with >3 mentions across sessions get description regenerated with full context
6. **Perspective-aware dedup** — fuzzy dedup within same perspective only
7. **URI-based file materialization** — three-level granularity:
   ```
   enox.dev/personal/vadim_r/
   ├── graph.jsonl.gz              ← full dump
   ├── manifest.json               ← counts, schema version, last updated
   ├── cs/
   │   ├── knowledge_graph.json    ← single entity + edges + embedding
   │   ├── graph.jsonl.gz          ← domain dump (incl cross-domain edges)
   │   └── manifest.json           ← domain stats, cross-domain edge count
   ├── enox/
   │   ├── perspective.json
   │   ├── graph.jsonl.gz
   │   └── manifest.json
   ```
   - Entity file = self-contained (node + all edges + embedding vector)
   - Domain dump = all entities in domain + cross-domain edges (duped in both domains)
   - Full dump = everything, for cold start / replication
   - Dedup on import via fact_id — already works
   - Current JSONL snapshots are temporary bulk backup, this replaces them
8. **Search by URI prefix** — `/api/nodes?prefix=enox://enox.dev/personal/vadim_r/cs/` for domain scoping

## Architecture decisions
- URI: `enox://enox.dev/personal/vadim_r/{domain}/{entity}`
- Domain: free-form string, not enum — new domains emerge organically
- Perspective = separate extractor prompt + own relation types + own node types
- Dedup: exact URI match (free) → fuzzy candidates (Levenshtein/aliases) → LLM Judge (Sonnet)
- Cross-perspective entities are NOT duplicates — opinions ABOUT a concept != the concept itself
- Edge dedup via fact_id = SHA256(source + "|" + relation + "|" + target)
- Sessions and sources are first-class entities in the graph (type: event/channel)
- Embeddings: all-MiniLM-L6-v2, 384 dims, stored alongside KuzuDB, background worker
- Backup: JSONL snapshots (temporary), URI-based file tree (planned)
