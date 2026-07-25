#!/usr/bin/env bash
# Deploy the Enox Smart Node to your own server (Docker).
# Near-zero-downtime: stop old container -> start new one (a few seconds gap).
#
# Usage:
#   HOST="root@YOUR_SERVER_IP" AUTH_TOKEN="your-secret" ./deploy.example.sh
#   HOST="root@YOUR_SERVER_IP" ./deploy.example.sh --data-only   # skip rebuild
#
# This is a TEMPLATE. It ships with ZERO real hosts, IPs, or tokens.
# Fill in HOST and AUTH_TOKEN via environment variables (never commit real ones).
set -euo pipefail

# ── Configuration (override via environment) ─────────────────────────────────
HOST="${HOST:-root@YOUR_SERVER_IP}"          # e.g. root@203.0.113.10
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"  # path to the private key for HOST
REMOTE_APP="${REMOTE_APP:-/opt/enox-smart-node}"
AUTH_TOKEN="${AUTH_TOKEN:-}"                  # write-API auth token (required for private mode)
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://api.example.org}"  # public URL used to build share links
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DATA_ONLY="${1:-}"

if [[ "$HOST" == "root@YOUR_SERVER_IP" ]]; then
  echo "ERROR: set HOST to your server, e.g. HOST=\"root@203.0.113.10\" ./deploy.example.sh" >&2
  exit 1
fi

ssh_cmd()   { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$HOST" "$@"; }
rsync_cmd() { rsync -az -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" "$@"; }

# ── 1. Sync source + build the Docker image on the server ────────────────────
if [[ "$DATA_ONLY" != "--data-only" ]]; then
  echo "==> Syncing source to $HOST:$REMOTE_APP ..."
  ssh_cmd "mkdir -p $REMOTE_APP"
  rsync_cmd --delete \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='data' \
    --exclude='.env' \
    --exclude='.env.*' \
    "$SCRIPT_DIR/" "$HOST:$REMOTE_APP/"

  echo "==> Building Docker image on server..."
  ssh_cmd "cd $REMOTE_APP && docker build -t enox-smart-node:latest ."
fi

# ── 2. Restart the container (KuzuDB needs an exclusive lock) ─────────────────
echo "==> Restarting container..."
echo "    AUTH_TOKEN: ${AUTH_TOKEN:+set (${#AUTH_TOKEN} chars)}"
ssh_cmd "
  docker stop -t 30 enox-smart-node 2>/dev/null || true
  docker rm enox-smart-node 2>/dev/null || true

  docker run -d \
    --init \
    --name enox-smart-node \
    --restart unless-stopped \
    -p 3700:3700 \
    -v $REMOTE_APP/data:/data \
    -e PORT=3700 \
    -e KUZU_DB_PATH=/data/enox.db \
    -e SQLITE_PATH=/data/enox-meta.sqlite \
    -e NODE_NAME=node \
    -e NODE_MODE=private \
    -e PUBLIC_BASE_URL=${PUBLIC_BASE_URL} \
    -e AUTH_TOKEN=${AUTH_TOKEN} \
    enox-smart-node:latest
"

# ── 3. Wait for health ───────────────────────────────────────────────────────
echo "==> Waiting for health check..."
for i in $(seq 1 30); do
  if ssh_cmd "curl -sf http://localhost:3700/health" >/dev/null 2>&1; then
    echo "==> Healthy after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "(not ready after 30s — check: ssh $HOST docker logs enox-smart-node)"
