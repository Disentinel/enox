# Enox — Personal Node

A self-hostable node for **Enox**, a federated knowledge-graph protocol where the
primary unit is the **relation**, not the document.

## What Enox is

Most "knowledge bases" store *documents* — notes, pages, chunks — and bolt search on
top. Enox stores **claims about how things relate**. The atom is an edge:

```
(source entity) --[relation]--> (target entity)   { confidence, provenance, perspective }
```

Every edge carries:

- **confidence** — how strongly the claim is held (0–1), not a boolean fact/not-fact.
- **provenance** — *who* asserted it (`asserted_by`) and in what context, so a human
  note, an agent's inference, and an imported paper are distinguishable and auditable.
- **perspective** — the lens the claim was extracted under, so competing or
  domain-specific views coexist instead of overwriting each other.

Contrast:

| | Document store / vector DB | Flat wiki / KB | **Enox** |
|---|---|---|---|
| Primary unit | document / chunk | page | **relation (edge)** |
| "Is it true?" | n/a (retrieval only) | implicit | **explicit confidence** |
| Who said it | lost in the blob | page history | **per-edge provenance** |
| Conflicting views | collide / dedup away | last-write-wins | **coexist as perspectives** |
| Cross-owner links | — | — | **federated URIs** |

Because entities are addressed by URI (`enox://example.org/graph/main/...`), nodes can
reference each other across owners — that's the **federated** part. See
[`../PROTOCOL.md`](../PROTOCOL.md) for the full v0.2 spec.

## Why it exists

It's built to be an agent's long-term memory and a decision-support substrate: a store
you can query for "what do we know about X, how confident are we, and who says so" —
and then hand a *slice* of to someone else as a live, queryable share (see below),
rather than exporting a dead document.

## Quickstart

Requires Docker with Compose.

```bash
docker compose up --build
```

That's it — the node comes up on **http://localhost:3700**:

- Web UI (the SPA wiki/graph explorer) at `/`
- REST API under `/api/...`
- MCP endpoint at `/mcp`

The default `AUTH_TOKEN` is `changeme`. **Set your own before exposing the node:**

```bash
AUTH_TOKEN=$(openssl rand -hex 24) docker compose up --build
```

Graph data, metadata, snapshots, and share tokens persist in `./data/` (a Docker volume
mount). Deleting that directory resets the node.

## Configuration

All configuration is via environment variables (see `docker-compose.yml` /
`.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3700` | HTTP port the node listens on. |
| `AUTH_TOKEN` | *(none → auth disabled)* | Bearer token required for all writes and private reads. **Set this.** |
| `NODE_MODE` | `private` | `private` = auth required for writes; `public` = read-only API served without auth. |
| `KUZU_DB_PATH` | `./data/enox.db` | Path to the KuzuDB graph store. |
| `SQLITE_PATH` | `./data/enox-meta.sqlite` | Path to the SQLite metadata DB (queue, metrics, shares, activity log). |
| `NODE_URI_PREFIX` | `enox://example.org/graph/main` | URI namespace this node mints entity IDs under. Set to your own host. |
| `PUBLIC_BASE_URL` | `https://api.example.org` | Public URL the node is reachable at — used to build share links. Set to your real base URL when sharing externally. |
| `NODE_NAME` | `node` | Display name for this node. |
| `NODE_PEERS` | *(none)* | Federation peers, `prefix1=url1,prefix2=url2`. |

## Interfaces

- **REST** — `/api/nodes`, `/api/assertions`, `/api/shares`, `/api/artifacts`,
  `/api/queue`, `/api/metrics`, ... Writes require `Authorization: Bearer $AUTH_TOKEN`.
- **MCP** — `/mcp` (Streamable HTTP + SSE). Point an MCP client (e.g. Claude) at it to
  read and write the graph as tools. Same bearer auth.
- **Web UI** — a React SPA served at `/` by the node itself (built from `client/` at
  image-build time). It's a wiki/graph explorer: dashboard, timeline, node explorer,
  force-directed graph view, queue, perspectives, metrics, and wiki/artifact pages. Log
  in with your `AUTH_TOKEN`.

## Create a share

A *share* is a live, read-only slice of your graph — selected by domain — that you can
hand to another person or agent. It gets its own token, landing page, and MCP endpoint,
so the recipient can query the slice without touching the rest of your graph.

```bash
TOKEN=changeme   # your AUTH_TOKEN

# 1. Create a share over one or more domains
curl -sX POST http://localhost:3700/api/shares \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My research slice","domains":["cs","ml"],"ttl_days":30}'
# → { "id": "<share-id>", "token": "<share-token>", "url": ".../share/<share-id>?token=..." }

# 2. Open the share landing page (uses the SHARE's own token, not your AUTH_TOKEN)
curl -s "http://localhost:3700/share/<share-id>?token=<share-token>"
```

The landing response advertises the share's own MCP endpoint
(`/share/<share-id>/mcp?token=...`) and REST base (`/share/<share-id>/api`). Refresh the
snapshot after graph changes with `POST /api/shares/<share-id>/refresh`, and revoke with
`DELETE /api/shares/<share-id>`.

## Optional: LLM-assisted features

Two convenience features shell out to the `claude` CLI (installed in the image):

- the **dedup worker's link-judge** — suggests relations between semantically similar
  entities, and
- **freetext-note extraction** (`POST /api/ingest`).

Both are **optional and degrade gracefully**. Without a `CLAUDE_CODE_OAUTH_TOKEN` (or
`ANTHROPIC_API_KEY`) the node still starts, serves, and merges duplicate entities
deterministically — it simply logs `LLM judge disabled` and skips the LLM steps. To drop
the dependency entirely, delete the `npm install -g @anthropic-ai/claude-code` line in
the `Dockerfile`. To enable it, set `CLAUDE_CODE_OAUTH_TOKEN` in the environment (an
example line is commented in `docker-compose.yml`).

## Local development (without Docker)

```bash
npm ci
npm run build          # tsc → dist/
npm run build:client   # vite → dist/client/
npm start              # node dist/index.js
# or: npm run dev:all  # backend + client dev servers with hot reload
```

## Protocol & spec

See [`../PROTOCOL.md`](../PROTOCOL.md) for the Enox v0.2 protocol specification
(entities, assertions, perspectives, federation, shares).

## License

See [`../LICENSE`](../LICENSE).
