FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist dist/

ENV PORT=3700
ENV KUZU_DB_PATH=/data/enox.db

EXPOSE 3700

CMD ["node", "dist/index.js"]
