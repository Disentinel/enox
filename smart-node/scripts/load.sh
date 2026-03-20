#!/bin/bash
# Load ENOX JSONL into Smart Node via CRUD API
# Usage: ./load.sh <input.enox.jsonl> [base_url]

set -euo pipefail

INPUT="${1:?Usage: ./load.sh <input.enox.jsonl> [base_url]}"
BASE="${2:-http://localhost:3700}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Check server is up
if ! curl -sf "$BASE/health" > /dev/null 2>&1; then
    echo -e "${RED}[load] Server not reachable at $BASE${NC}"
    exit 1
fi

echo -e "${GREEN}[load]${NC} Loading $INPUT into $BASE"

# Phase 1: Load nodes
NODE_OK=0
NODE_FAIL=0
while IFS= read -r line; do
    TYPE=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.readline()).get('_type',''))")
    [ "$TYPE" != "node" ] && continue

    PAYLOAD=$(echo "$line" | python3 -c "
import sys, json
obj = json.loads(sys.stdin.readline())
out = {
    'type': obj.get('node_type', 'concept'),
    'name': obj.get('label', ''),
    'description': obj.get('description', ''),
    'aliases': obj.get('aliases', [])
}
# Use the enox ID as the node ID by including it
print(json.dumps(out))
")

    # Extract the enox ID to use as our node ID
    ENOX_ID=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.readline())['id'])")

    # Create node — the API generates its own ID, but we need to map enox IDs
    RESP=$(curl -sf -X POST "$BASE/api/nodes" \
        -H 'Content-Type: application/json' \
        -d "$PAYLOAD" 2>/dev/null || echo "FAIL")

    if [ "$RESP" != "FAIL" ] && echo "$RESP" | python3 -c "import sys,json; json.loads(sys.stdin.readline())" 2>/dev/null; then
        NODE_OK=$((NODE_OK + 1))
    else
        NODE_FAIL=$((NODE_FAIL + 1))
    fi
done < "$INPUT"

echo -e "${GREEN}[load]${NC} Nodes: $NODE_OK ok, $NODE_FAIL failed"

echo -e "${YELLOW}[load]${NC} Note: Edges not loaded — CRUD API needs node IDs from the API, not enox IDs."
echo -e "${YELLOW}[load]${NC} For full graph loading, use the direct KuzuDB loader (TODO) or the MCP add_assertion tool."
echo -e "${GREEN}[load]${NC} Done"
