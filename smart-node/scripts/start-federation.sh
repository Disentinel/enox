#!/bin/bash
# Start both nodes in federation mode
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$NODE_DIR"

echo "[federation] Starting personal node (port 3700)..."
env $(cat .env.personal | grep -v '^#' | xargs) npx tsx src/index.ts &
PID1=$!

echo "[federation] Starting sources node (port 3701)..."
env $(cat .env.sources | grep -v '^#' | xargs) npx tsx src/index.ts &
PID2=$!

echo "[federation] Running. PIDs: personal=$PID1 sources=$PID2"
echo "[federation] Personal: http://localhost:3700"
echo "[federation] Sources:  http://localhost:3701"
echo "[federation] Press Ctrl+C to stop both"

trap "kill $PID1 $PID2 2>/dev/null; wait" SIGINT SIGTERM
wait
