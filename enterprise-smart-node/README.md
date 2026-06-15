# Enterprise Smart Node

A self-hostable, multi-tenant **knowledge-graph node** for teams. It stores
provenanced assertions ("who said what about what, and why") in a property
graph, embeds every node and assertion for semantic search, and exposes the
graph over both a REST API and the **Model Context Protocol (MCP)** so AI agents
(Claude Code, etc.) can read and write the team's shared knowledge directly.

This is the open-source, de-personalized core of the Enox smart node. See
[`SCOPE-NOTES.md`](./SCOPE-NOTES.md) for exactly what was removed/kept for the
public release.

## What's in the box

- **Per-user token auth** — every request is a bearer token mapping to a user;
  every assertion is attributed to the authenticated user (`asserted_by`).
- **Admin console** at `/admin` — create users, enable/disable them, issue and
  revoke MCP/API tokens. Tokens are stored as `sha256(token)`; the raw value is
  shown exactly once on issue.
- **Schemaless graph** — node `type` and `relation` are free strings. A curated
  list of suggested types is surfaced in the tool/API descriptions to nudge
  consistency, but nothing rejects a custom type (e.g. `custom_widget`).
- **MCP server** — 14 tools (`query_graph`, `add_assertion`, `semantic_search`,
  `recall`, `explore`, `traverse`, `batch_assertions`, `remember`, `decide`,
  `graph_stats`, `recent_activity`, `update_node`, `update_assertion`,
  `delete_assertion`) over both StreamableHTTP (`/mcp`) and SSE (`/sse`).
- **REST API** at `/api` — nodes, assertions, queue, workers, perspectives,
  metrics, JSONL export/snapshots, server-side graph layout.
- **Web UI** — a React graph explorer at `/` (plus a legacy console at
  `/legacy`).

## Stack

| Layer | Tech | Purpose |
|-------|------|---------|
| Graph store | **KuzuDB** (`KUZU_DB_PATH`) | nodes + assertions (the property graph) |
| Metadata store | **SQLite** (`SQLITE_PATH`) | users, API tokens, task queue, workers, metrics |
| Embeddings | **ONNX `all-MiniLM-L6-v2`** via `@huggingface/transformers` | 384-dim vectors for every node + assertion |
| Vector index | in-process cosine search, persisted to `embeddings.json` next to the graph | semantic search / recall |
| Server | **Express 5** + **@modelcontextprotocol/sdk** | REST + MCP transports |
| Client | **React 19** + **Vite** + **sigma.js** | graph explorer UI |

All persistent state — the KuzuDB graph, the SQLite metadata DB, and the
persisted embeddings — lives under **`/data`** in the container. Mount a named
volume there to keep your knowledge across restarts.

> The embedding model is **baked into the Docker image** (see the final stage of
> the `Dockerfile`), so the node works offline and the first request never waits
> on a model download.

## Quick start (Docker)

### 1. Build

```bash
docker build -t enox-smart-node .
```

The build compiles the server and client, then **prewarms the all-MiniLM model
into the final image** — the build takes a little longer but no model is
downloaded at runtime.

### 2. Run

```bash
docker volume create enox-data

docker run -d --name enox \
  -p 3700:3700 \
  -v enox-data:/data \
  -e NODE_MODE=private \
  -e ADMIN_USER=admin \
  -e ADMIN_TOKEN='change-me-to-a-long-random-secret' \
  enox-smart-node
```

On the **first boot with an empty DB**, the node bootstraps an admin user named
`$ADMIN_USER` and registers `$ADMIN_TOKEN` as its bearer token (see
`src/index.ts` → `ensureBootstrapAdmin`). If you omit `ADMIN_TOKEN`, the node
mints a random token and prints it once to the logs:

```bash
docker logs enox | grep '\[auth\]'
# [auth] Bootstrapped admin user "admin".
# [auth] Admin bearer token (store it now — shown once): enox_…
```

Bootstrap only runs while there are zero users — changing `ADMIN_TOKEN` later
has no effect; rotate tokens from the admin console instead.

### 3. Use it

```bash
# Health (no auth)
curl -s localhost:3700/health

# Authenticated read
curl -s localhost:3700/api/nodes -H "Authorization: Bearer $ADMIN_TOKEN"
```

Open the admin console at **http://localhost:3700/admin**, paste the admin
token, and create per-user tokens for your teammates and agents. Open the graph
explorer at **http://localhost:3700/**.

## Auth model

- **`NODE_MODE=private`** (default) — all writes, and reads of non-public nodes,
  require a valid bearer token. Each token resolves to exactly one user;
  assertions that user writes are attributed to them. Disabled users and revoked
  tokens are rejected. System-generated edges (dedup, etc.) are attributed to
  `system`/`dedup_worker`, never to a person.
- **`NODE_MODE=public`** — the REST API is open read-only; writes still require
  auth. Use this for a read-only published node.
- **Admin role** — required for the `/api/admin/*` user/token endpoints and the
  `/admin` console. The bootstrap user is an admin.
- A legacy single shared token (`AUTH_TOKEN`) is still honoured and maps to the
  admin user, but **per-user tokens issued from the console are preferred**.

## Schemaless note

`type` (on nodes) and `relation` (on assertions) are plain strings — you are not
locked into a fixed ontology. The server ships a non-binding list of *suggested*
types (e.g. `concept`, `decision`, `component`, `pattern`, `depends_on`,
`supersedes`, `implements`, `contradicts`, …) that appears in the MCP/API
descriptions to keep a team's vocabulary coherent. Introduce your own types
freely; just keep them consistent (see the bundled write-methodology skill in
[`skills/`](./skills/)).

## Configuration (env)

See [`.env.example`](./.env.example) for the full annotated list. The ones that
matter for a Docker deployment:

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3700` | HTTP port |
| `NODE_MODE` | `private` | `private` (auth) or `public` (read-only open) |
| `KUZU_DB_PATH` | `/data/enox.db` | graph store path (keep under the volume) |
| `SQLITE_PATH` | `/data/enox-meta.sqlite` | users/tokens/queue store |
| `NODE_NAME` | `default` | display name for this node |
| `NODE_URI_PREFIX` | `enox://local/default` | URI prefix for entities created here |
| `NODE_PEERS` | _(empty)_ | federation peers `prefix=url,prefix=url` |
| `ADMIN_USER` | `admin` | first-admin username (bootstrap only) |
| `ADMIN_TOKEN` | _(empty)_ | first-admin token (bootstrap only; random if unset) |
| `AUTH_TOKEN` | _(empty)_ | optional legacy shared token → admin user |

## HuggingFace / corporate DLP proxy note

The image bakes `Xenova/all-MiniLM-L6-v2` at build time. If you rebuild **behind
a TLS-intercepting corporate DLP/MITM proxy**, the model download from the
HuggingFace CDN can fail with a certificate-verification error, because Node does
not trust your proxy's self-signed root CA.

**Fix it the safe way — add your corporate CA to Node's trust store**, do **not**
disable TLS verification:

```dockerfile
# In the runtime stage, before the bake step:
COPY corp-root-ca.pem /usr/local/share/ca-certificates/corp-root-ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-root-ca.crt
```

or at build time without editing the Dockerfile:

```bash
docker build \
  --build-arg NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem \
  -t enox-smart-node .
```

`NODE_EXTRA_CA_CERTS` makes Node trust the self-signed certs in your proxy's
chain while keeping full TLS verification on. **Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`** — that disables certificate validation for the
whole process and is a security hole, not a fix. If your proxy needs explicit
egress, set `HTTPS_PROXY` as well.

## Agent integration

See [`INTEGRATION.md`](./INTEGRATION.md) for a ready-to-paste Claude Code prompt
that builds the image, runs the container, registers the MCP server in your
`.mcp.json`, verifies `tools/list`, and creates a test user + token.

## Skills

[`skills/`](./skills/) ships two Enox skills for agents and operators:

- **`enox-write-methodology`** — how to write good, atomic, well-attributed
  assertions and nodes into the graph.
- **`enox-team-how-to-write`** — conventions for a team sharing one Enox node:
  vocabulary, attribution, sessions, and avoiding duplicates.

## License

See the repository root `LICENSE`.
