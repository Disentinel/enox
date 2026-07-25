# Enterprise Smart Node — Scope & De-personalization Notes

This package is the open-source, multi-tenant core of the Enox smart-node, derived
from the full private source. This file records what was removed/scrubbed for the
public release and which modules were judged owner-specific or sensitive enough to
flag for owner review.

## De-personalization (hard safety gate)

The following grep returns ZERO across `*.ts/*.js/*.md/*.sh/*.json` (excluding
`node_modules` and `package-lock.json`):

```
grep -rInE "<owner-name>|<owner-id>|<owner-handles>|<owner-server-ip>|<owner-host>"
  enterprise-smart-node --include=*.ts --include=*.js --include=*.md --include=*.sh --include=*.json
```
(The real owner tokens are intentionally NOT written in this file so it does not
itself trip the gate.)

### Removed files (owner infra / secrets / personal data)
- `deploy.sh`, `deploy-abstract-dl-pub.sh` — owner deployment scripts containing a
  real server IP (`<owner-server-ip>`), `<owner-host>` hostname, and SSH targets.
- `TODO.md` — owner planning notes with personal URIs.
- `.env` — **contained REAL Telegram API credentials** (`TG_API_ID`, `TG_API_HASH`).
  Hard secret leak; deleted.
- `.env.personal`, `.env.arxiv`, `.env.sources` — owner per-node configs with the
  personal URI prefix `enox://<owner-prefix>` and concrete peer topology.
- `docs/` (only file: `abstract-dl-pub-access.md`) — owner deployment/access doc
  pointing at `<owner-host>`.
- `.kdl-markers/` — owner session-tracking markers (tied to the owner's local
  `~/.claude/projects/...` session path).
- `scripts/` — the **entire** extraction-pipeline tooling. EXCLUDED for two reasons:
  1. **Personal data leak:** `scripts/output/` held ~295 JSONL files of the owner's
     *extracted personal graph* (opinions, personal finances, song-lyric analysis,
     career notes, Telegram channel dumps `<channel-a>`/`<channel-b>`/`<owner-channel-c>`, etc.).
  2. **Owner-specific harness:** `tg-fetch.py`, `tg-login-qr.py`, `add-sessions.py`,
     `extract-opinions.md` (references `personal/<owner-username>`), `kdl-check.sh`
     (hardcoded owner session path), `load-merged.ts` (personal default prefix).
  None of `src/` imports from `scripts/`, so removal is clean. See "Excluded
  modules" below — a sanitized ingestion/extraction toolkit should be re-authored
  separately for the public release if desired.

### Scrubbed in place (kept, but de-personalized)
- `src/config.ts` — `uriPrefix` default → `enox://local/default` (env `NODE_URI_PREFIX`);
  `NODE_NAME` default `personal` → `default`; comments neutralized.
- `src/types.ts` — `ENTITY_URI_PREFIX` default → `enox://local/default`; comments fixed.
- `src/mcp/tools.ts`, `src/crud/assertions.ts`, `src/crud/ingest.ts`, `src/backup.ts` —
  every hardcoded `asserted_by: '<owner>'` / `by: 'agent'` replaced (see attribution below).
- `src/crud/ingest.ts` — the Sonnet extraction prompt was rewritten from a personal
  "a note from <owner> about his knowledge graph" to a neutral "a note from a user", and the example
  URI is now derived from the configured prefix.
- `.env.example` — rewritten to neutral, documented config (no Telegram, no personal prefix).

## Core feature work delivered

### Schemaless data model
- `src/types.ts`: dropped the fixed `NODE_TYPES` / `RELATION_TYPES` enums. `NodeType`
  and `RelationType` are now `string`. The former lists are kept as **non-binding**
  `SUGGESTED_NODE_TYPES` / `SUGGESTED_RELATION_TYPES` surfaced only in tool/API
  descriptions.
- `src/crud/validators.ts`: `type` / `relation` are now `z.string().min(1)`.
- `src/mcp/tools.ts`: every `z.enum(NODE_TYPES|RELATION_TYPES)` → `z.string()`.
- `src/workers/dedup.ts`: `VALID_RELATIONS` set → `isValidRelation()` (any non-empty string).
- Verified live: a node with custom type `custom_widget` is accepted (old enum rejected it).

### Per-user attribution (asserted_by derived from the authenticated user)
- The authenticated username is threaded into every assertion-create path:
  - MCP: `transport.ts` resolves the caller (`req.userId`, set by `requireAuth`) and
    passes it to `createMcpServer(assertedBy)` → `registerTools(server, assertedBy)`.
    `add_assertion`, `remember`, `batch_assertions` all write `asserted_by: assertedBy`.
  - HTTP CRUD: `createAssertion` and `ingest` use `req.userId ?? 'system'`.
- System-generated edges keep honest non-personal attribution: `dedup_worker` for
  auto-links; edge-copy paths preserve the original `asserted_by`. `backup.ts` fallback
  changed from `'<owner>'` to `'system'`.

### Token auth on HTTP / MCP
- `src/auth/users.ts` (new): SQLite-backed users + API tokens. Tokens are stored as
  `sha256(token)` only; raw token shown once on issue. `resolveToken()` maps a bearer
  token → its (enabled, non-revoked) owner. `ensureBootstrapAdmin()` seeds a first
  admin on an empty DB.
- `src/db/sqlite.ts`: schema migration **V3** adds `users` + `api_tokens` tables.
- `src/auth/middleware.ts` rewritten: `requireAuth` rejects unauthenticated requests
  in `private` mode (401), resolves the bearer token to a user, and attaches
  `req.user` / `req.userId`. Legacy shared `AUTH_TOKEN` still works (maps to the
  `ADMIN_USER`). `public` nodes stay open read-only. `requireAdmin` added.
- Applied to `/api`, `/api/queue`, `/api/workers`, `/mcp`, `/sse`, `/sse/messages`.
- Verified live: unauthenticated `/api/nodes` → 401; valid per-user token → 200.

### Admin GUI (extends src/public)
- `src/public/admin.html` (new): minimal admin console — create users, enable/disable
  users, issue/revoke remote-MCP tokens. Talks to a new admin API.
- `src/auth/router.ts` (new): `/api/admin/{users,tokens}` CRUD, guarded by `requireAdmin`.
- Served at `/admin`. Build now copies `src/public/*.html` → `dist/public/`
  (`copy:assets` npm script) so it ships in production too.

### Storage / embeddings stack — unchanged
KuzuDB + LanceDB + ONNX all-MiniLM-L6-v2 retained as-is (not swapped).

## Modules KEPT but flagged for owner review

These are generic infrastructure (no personal data found in them), kept in scope, but
the owner may want to decide whether they belong in the first public cut:

- `src/federation.ts`, `src/federation-edges.ts`, and the `/api/federation/*` routes —
  cross-node URI resolution + cross-edges. Generic, but it assumes a peer topology;
  review whether the federation surface should ship in v1.
- `src/perspectives/` — extraction "perspective" definitions. `seedDefaults()` seeds
  four generic perspectives (Knowledge Extraction, Temporal Events, Opinions &
  Preferences, Intent & Task). These are descriptive metadata only — they carry an
  `llm_model` field but the node never invokes an LLM from them; an external,
  operator-run extractor is expected to consume them.
- `src/queue/`, `src/workers/` (incl. `dedup.ts`) — task queue + worker pool + entity
  dedup. The dedup worker does deterministic, embedding-based merges with NO LLM. Its
  generative "LLM-judge" link-suggestion step is OPT-IN (see below) and is skipped with
  a log line when no LLM is configured; the worker never crashes the node and never
  spawns a CLI implicitly.
- `src/crud/ingest.ts` — free-text note→graph extraction. LLM-dependent and OPT-IN; with
  the LLM disabled (the default) `POST /api/ingest` returns HTTP 501 with a clear,
  actionable opt-in message instead of spawning anything.

### LLM features are OFF by default (pure data layer)

The node stores / queries / traverses / locally-embeds (ONNX) / authenticates / admins
with **no LLM and no `claude` CLI on the host**. The two LLM-dependent features above are
gated behind a single mechanism in `src/llm.ts`:

- `LLM_INGEST_ENABLED` (default off) — master switch.
- `LLM_CMD` — operator-supplied command; receives the prompt on STDIN, prints the
  completion to STDOUT. `{model}` is substituted with the requested model name. No
  provider is hardcoded (e.g. `LLM_CMD="claude -p --model {model} --output-format text"`).

When disabled or unconfigured, any LLM-dependent op fails with `LlmDisabledError` (a clear
opt-in message) — it never silently spawns `claude` and never crashes the process. The
default Docker image does NOT install any LLM CLI; the Dockerfile documents how an operator
extends the image to enable these features.

## EXCLUDED — left out, flagged for owner review

- **Ingestion / extraction toolkit** (the deleted `scripts/`): Telegram fetchers,
  session loaders, opinion/temporal extractors, batch runners, canonicalizers. Too
  owner-specific and entangled with personal data to publish as-is. If a public
  extraction toolkit is wanted, re-author it cleanly (no personal IDs, no `output/`).
- **Owner deployment** (`deploy*.sh`, `docs/abstract-dl-pub-access.md`): replace with
  generic deployment docs (the second agent owns Docker/README).

## Honest gaps / caveats
- The MCP transport binds `asserted_by` to the user resolved at connection time. For
  StreamableHTTP, identity is captured when the session is created; tokens are not
  re-checked per message within an existing session (standard for these transports).
- `npm install` reports pre-existing dependency vulnerabilities (audit) inherited from
  the seed's dependency tree — not introduced by this work; not addressed here.
- I did not add automated tests; verification was a live smoke test (boot, 401 on
  unauth, admin user/token CRUD, schemaless custom-type node create) plus `tsc --noEmit`
  (0 errors) and a full `npm run build` (0 errors, assets copied).
