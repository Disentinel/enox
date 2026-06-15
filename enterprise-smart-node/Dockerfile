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

# Install claude CLI for LLM judge (used by dedup worker)
RUN npm install -g @anthropic-ai/claude-code

COPY --from=builder /app/dist dist/

ENV PORT=3700
ENV KUZU_DB_PATH=/data/enox.db

EXPOSE 3700

CMD ["node", "dist/index.js"]
