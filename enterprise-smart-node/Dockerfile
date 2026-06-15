# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Enterprise Smart Node — single-container, multi-stage image.
#
#   stage 1 (builder)  : install full deps, compile TS + Vite client bundle
#   stage 2 (runtime)  : prod-only deps, then BAKE the embedding model into the
#                        image so the first request never has to download it.
#
# The graph (KuzuDB), the user/token/queue store (SQLite) and the persisted
# embeddings all live under /data — mount a named volume there to keep state.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# better-sqlite3 / kuzu ship native bindings; node:22-slim has no toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src/ src/
COPY client/ client/

# Server (tsc + asset copy) and the React client bundle.
RUN npm run build && npm run build:client

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Native bindings (better-sqlite3 / kuzu) need a compiler at `npm ci` time even
# for the prod-only install, and ca-certificates so the model download below can
# validate TLS. (Behind a TLS-intercepting DLP proxy, see README → set
# NODE_EXTRA_CA_CERTS — do NOT disable TLS verification.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# NOTE: the default image is a PURE DATA LAYER and deliberately ships with NO
# LLM and NO `claude` CLI. Store / query / traverse / local-ONNX embed / auth /
# admin all work with zero LLM. The LLM-dependent features (free-text note→graph
# ingestion, LLM-judged dedup linking) are OPT-IN: an operator who wants them
# sets LLM_INGEST_ENABLED=1 and LLM_CMD to a command of their choice, and is
# responsible for making that command available on the host — e.g. by extending
# this image:
#     RUN npm install -g @anthropic-ai/claude-code
#     ENV LLM_INGEST_ENABLED=1 \
#         LLM_CMD="claude -p --model {model} --output-format text"

# ── BAKE THE MODEL INTO THE FINAL IMAGE ──────────────────────────────────────
# CRITICAL: this MUST run in the FINAL stage, AFTER `npm ci --omit=dev`.
#
# @huggingface/transformers v3 caches downloaded model files under its own
# package dir: node_modules/@huggingface/transformers/.cache/ (env.cacheDir,
# computed relative to the installed package — it does NOT read HF_HOME /
# TRANSFORMERS_CACHE). The application calls exactly:
#     pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'fp32'})
# so we run the identical call here to populate that same cache. A cache warmed
# in the builder stage would be discarded across the stage boundary — baking it
# here is what makes the model present in the shipped image (offline-capable,
# zero first-request download).
RUN node -e "import('@huggingface/transformers').then(async ({ pipeline }) => { \
      await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{ dtype:'fp32' }); \
      console.log('[bake] all-MiniLM-L6-v2 cached into final image'); \
    }).catch((e) => { console.error('[bake] model prewarm failed:', e); process.exit(1); })"

# Compiled server + copied admin/legacy HTML + React client bundle.
COPY --from=builder /app/dist dist/

# ── Runtime config ───────────────────────────────────────────────────────────
# All persistent state under /data (mount a named volume here).
ENV PORT=3700 \
    NODE_MODE=private \
    KUZU_DB_PATH=/data/enox.db \
    SQLITE_PATH=/data/enox-meta.sqlite \
    NODE_URI_PREFIX=enox://local/default \
    NODE_NAME=default

# First-admin bootstrap (read by src/index.ts → ensureBootstrapAdmin):
#   ADMIN_USER  — username of the first admin (default "admin")
#   ADMIN_TOKEN — its bearer token; created ONLY on an empty DB (first boot)
# Provide ADMIN_TOKEN at `docker run` time; leaving it unset makes the node mint
# a random token and print it once to stdout on first boot.
ENV ADMIN_USER=admin

VOLUME ["/data"]
EXPOSE 3700

CMD ["node", "dist/index.js"]
