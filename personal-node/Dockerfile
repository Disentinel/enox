FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src/ src/
COPY client/ client/

RUN npm run build && npm run build:client

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# OPTIONAL: the `claude` CLI powers two convenience features — the dedup worker's
# "LLM judge" (suggests links between similar entities) and freetext-note extraction
# (POST /api/ingest). Both degrade gracefully when it is absent: the node still runs,
# serves, merges duplicates deterministically, and only skips the LLM-assisted steps.
# The judge additionally requires an authenticated session (CLAUDE_CODE_OAUTH_TOKEN).
# Self-hosters who don't want the Anthropic dependency can delete the next line.
RUN npm install -g @anthropic-ai/claude-code

COPY --from=builder /app/dist dist/

ENV PORT=3700
ENV KUZU_DB_PATH=/data/enox.db

EXPOSE 3700

CMD ["node", "dist/index.js"]
