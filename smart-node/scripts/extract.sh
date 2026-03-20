#!/bin/bash
# ENOX Knowledge Extraction Pipeline
# Usage: ./extract.sh <input_text_file> [output_jsonl_file] [--perspective <name>]
#
# Perspectives: knowledge (default), temporal, opinions
# Each perspective uses its own prompt template from scripts/extract-*.md

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse args
PERSPECTIVE="knowledge"
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --perspective|-p)
            PERSPECTIVE="$2"
            shift 2
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done
set -- "${POSITIONAL[@]}"

INPUT="${1:?Usage: ./extract.sh <input.txt> [output.jsonl] [--perspective knowledge|temporal|opinions]}"
OUTPUT="${2:-${INPUT%.txt}.${PERSPECTIVE}.enox.jsonl}"

# Select prompt template by perspective
case "$PERSPECTIVE" in
    knowledge) PROMPT_TEMPLATE="$SCRIPT_DIR/extract-enox.md" ;;
    temporal)  PROMPT_TEMPLATE="$SCRIPT_DIR/extract-temporal.md" ;;
    opinions)  PROMPT_TEMPLATE="$SCRIPT_DIR/extract-opinions.md" ;;
    *)
        if [ -f "$SCRIPT_DIR/extract-${PERSPECTIVE}.md" ]; then
            PROMPT_TEMPLATE="$SCRIPT_DIR/extract-${PERSPECTIVE}.md"
        else
            echo "Error: Unknown perspective '$PERSPECTIVE'. Expected: knowledge, temporal, opinions, or a file extract-<name>.md"
            exit 1
        fi
        ;;
esac

CHUNK_SIZE=4000
OVERLAP=500

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${GREEN}[enox-extract]${NC} Perspective: $PERSPECTIVE"
echo -e "${GREEN}[enox-extract]${NC} Input: $INPUT"
echo -e "${GREEN}[enox-extract]${NC} Output: $OUTPUT"

# Check dependencies
command -v claude >/dev/null 2>&1 || { echo "Error: claude CLI not found"; exit 1; }

# Extraction is deliberately dumb — no dedup context.
# Dedup happens post-load via dedup-sweep.py across the whole federation.
PROMPT_BASE=$(cat "$PROMPT_TEMPLATE")
# Remove EXISTING_GRAPH placeholder if present in template
PROMPT_BASE="${PROMPT_BASE//\{\{EXISTING_GRAPH\}\}/(not provided — dedup is a separate post-load step)}"

# Split input into chunks
INPUT_TEXT=$(cat "$INPUT")
INPUT_LEN=${#INPUT_TEXT}
echo -e "${GREEN}[enox-extract]${NC} Input size: $INPUT_LEN chars"

CHUNK_NUM=0
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

START=0
while [ $START -lt $INPUT_LEN ]; do
    END=$((START + CHUNK_SIZE))
    if [ $END -gt $INPUT_LEN ]; then
        END=$INPUT_LEN
    fi

    CHUNK="${INPUT_TEXT:$START:$((END - START))}"

    CHUNK_FILE="$TMPDIR/chunk_${CHUNK_NUM}.txt"
    echo "$CHUNK" > "$CHUNK_FILE"

    CHUNK_NUM=$((CHUNK_NUM + 1))
    START=$((END - OVERLAP))
    if [ $START -lt 0 ]; then START=0; fi
    if [ $END -eq $INPUT_LEN ]; then break; fi
done

echo -e "${GREEN}[enox-extract]${NC} Split into $CHUNK_NUM chunks"

# Process each chunk
> "$OUTPUT.tmp"
for i in $(seq 0 $((CHUNK_NUM - 1))); do
    CHUNK_FILE="$TMPDIR/chunk_${i}.txt"
    CHUNK_TEXT=$(cat "$CHUNK_FILE")

    echo -e "${YELLOW}[chunk $((i+1))/$CHUNK_NUM]${NC} Extracting..."

    FULL_PROMPT="${PROMPT_BASE}${CHUNK_TEXT}"

    RESULT=$(echo "$FULL_PROMPT" | claude -p --model sonnet --output-format text 2>/dev/null || echo "")

    if [ -n "$RESULT" ]; then
        echo "$RESULT" | while IFS= read -r line; do
            if [ -n "$line" ] && echo "$line" | python3 -c "import sys,json; json.loads(sys.stdin.readline())" 2>/dev/null; then
                echo "$line" >> "$OUTPUT.tmp"
            fi
        done

        NODES=$(echo "$RESULT" | grep -c '"_type": "node"' || true)
        EDGES=$(echo "$RESULT" | grep -c '"_type": "edge"' || true)
        echo -e "${YELLOW}[chunk $((i+1))/$CHUNK_NUM]${NC} Got $NODES entities, $EDGES edges"
    else
        echo -e "${YELLOW}[chunk $((i+1))/$CHUNK_NUM]${NC} Empty result, skipping"
    fi
done

# Deduplicate: merge nodes with same ID, keep first occurrence
python3 << PYEOF
import json

seen_nodes = {}
seen_edges = set()
output = []

with open("$OUTPUT.tmp") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        if obj.get("_type") == "node":
            nid = obj["id"]
            if nid not in seen_nodes:
                seen_nodes[nid] = obj
                output.append(obj)
            else:
                existing = seen_nodes[nid]
                new_aliases = set(existing.get("aliases", []) + obj.get("aliases", []))
                existing["aliases"] = list(new_aliases)

        elif obj.get("_type") == "edge":
            key = (obj["from"], obj["rel"], obj["to"])
            if key not in seen_edges:
                if obj["from"] in seen_nodes and obj["to"] in seen_nodes:
                    seen_edges.add(key)
                    output.append(obj)

nodes = [o for o in output if o["_type"] == "node"]
edges = [o for o in output if o["_type"] == "edge"]

with open("$OUTPUT", "w") as f:
    for obj in nodes + edges:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")

print(f"Final: {len(nodes)} entities, {len(edges)} edges (deduped)")
PYEOF

rm -f "$OUTPUT.tmp"
echo -e "${GREEN}[enox-extract]${NC} Done → $OUTPUT"
