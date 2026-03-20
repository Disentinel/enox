#!/bin/bash
# Batch extraction of all sessions into personal knowledge graph
# Usage: ./batch-extract.sh [--max-parallel N] [--min-chars N] [--perspectives LIST]
#
# Processes web + local sessions, newest first.
# Loads results into personal node (localhost:3700).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$SCRIPT_DIR/output/batch"
SESSIONS_DIR="$NODE_DIR/sessions"
LOG_FILE="$OUTPUT_DIR/batch.log"

MAX_PARALLEL=${MAX_PARALLEL:-3}
MIN_CHARS=${MIN_CHARS:-2000}
PERSPECTIVES=${PERSPECTIVES:-"knowledge"}
LOAD_URL=${LOAD_URL:-"http://localhost:3700"}

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --max-parallel) MAX_PARALLEL="$2"; shift 2 ;;
        --min-chars) MIN_CHARS="$2"; shift 2 ;;
        --perspectives) PERSPECTIVES="$2"; shift 2 ;;
        *) shift ;;
    esac
done

mkdir -p "$OUTPUT_DIR"
echo "" > "$LOG_FILE"

log() { echo -e "$1" | tee -a "$LOG_FILE"; }

log "${GREEN}[batch]${NC} Starting batch extraction"
log "${GREEN}[batch]${NC} Parallel: $MAX_PARALLEL, Min chars: $MIN_CHARS, Perspectives: $PERSPECTIVES"
log "${GREEN}[batch]${NC} Output: $OUTPUT_DIR"

# Check servers
if ! curl -sf "$LOAD_URL/health" > /dev/null 2>&1; then
    log "${RED}[batch] Server not running at $LOAD_URL${NC}"
    exit 1
fi

# Step 1: Extract all web sessions to text files
log "${GREEN}[batch]${NC} Extracting web sessions to text files..."
python3 << 'PYEOF'
import json, os, sys

output_dir = os.environ.get('OUTPUT_DIR', 'scripts/output/batch')
sessions_dir = os.environ.get('SESSIONS_DIR', 'sessions')
min_chars = int(os.environ.get('MIN_CHARS', '2000'))

web_file = os.path.join(sessions_dir, 'web', 'conversations.json')
if not os.path.exists(web_file):
    print("No web conversations file found")
    sys.exit(0)

with open(web_file) as f:
    data = json.load(f)

# Sort by date desc
sessions = []
for c in data:
    msgs = c.get('chat_messages', [])
    name = c.get('name', 'untitled')
    created = c.get('created_at', '')[:10]

    lines = []
    for m in msgs:
        for part in m.get('content', []):
            if isinstance(part, dict) and part.get('type') == 'text':
                text = part.get('text', '').strip()
                if text:
                    lines.append(text)

    full_text = '\n\n---\n\n'.join(lines)
    if len(full_text) < min_chars:
        continue

    # Create safe filename
    slug = name.lower()
    slug = ''.join(c if c.isalnum() or c in ' -_' else '' for c in slug)
    slug = slug.strip().replace(' ', '_')[:50]
    filename = f"web_{created}_{slug}"

    sessions.append((created, filename, name, full_text))

sessions.sort(key=lambda x: x[0], reverse=True)

# Check which are already processed
txt_dir = os.path.join(output_dir, 'texts')
os.makedirs(txt_dir, exist_ok=True)

written = 0
skipped = 0
for created, filename, name, text in sessions:
    txt_path = os.path.join(txt_dir, f"{filename}.txt")
    jsonl_path = os.path.join(output_dir, f"{filename}.knowledge.enox.jsonl")

    if os.path.exists(jsonl_path):
        skipped += 1
        continue

    with open(txt_path, 'w') as f:
        f.write(text)
    written += 1

print(f"Web sessions: {written} to process, {skipped} already done, {len(sessions)} total")
PYEOF

# Also extract local Claude Code sessions
log "${GREEN}[batch]${NC} Extracting local sessions..."
python3 << 'PYEOF'
import json, os

output_dir = os.environ.get('OUTPUT_DIR', 'scripts/output/batch')
sessions_dir = os.environ.get('SESSIONS_DIR', 'sessions')
min_chars = int(os.environ.get('MIN_CHARS', '2000'))

local_dir = os.path.join(sessions_dir, 'local')
txt_dir = os.path.join(output_dir, 'texts')
os.makedirs(txt_dir, exist_ok=True)

if not os.path.exists(local_dir):
    print("No local sessions found")
    exit(0)

written = 0
for fname in sorted(os.listdir(local_dir)):
    if not fname.endswith('.jsonl'):
        continue

    session_id = fname.replace('.jsonl', '')[:12]
    filepath = os.path.join(local_dir, fname)

    lines = []
    with open(filepath) as f:
        for line in f:
            try:
                obj = json.loads(line)
                # Extract user and assistant messages
                if obj.get('type') in ('human', 'assistant'):
                    content = obj.get('message', {}).get('content', '')
                    if isinstance(content, str) and len(content) > 50:
                        lines.append(content[:5000])  # Cap individual messages
                    elif isinstance(content, list):
                        for part in content:
                            if isinstance(part, dict) and part.get('type') == 'text':
                                text = part.get('text', '')
                                if len(text) > 50:
                                    lines.append(text[:5000])
            except:
                continue

    full_text = '\n\n---\n\n'.join(lines)
    if len(full_text) < min_chars:
        continue

    filename = f"local_{session_id}"
    txt_path = os.path.join(txt_dir, f"{filename}.txt")
    jsonl_path = os.path.join(output_dir, f"{filename}.knowledge.enox.jsonl")

    if os.path.exists(jsonl_path):
        continue

    with open(txt_path, 'w') as f:
        f.write(full_text)
    written += 1

print(f"Local sessions: {written} to process")
PYEOF

# Step 2: Run extraction on all text files with controlled parallelism
TEXTS=$(ls "$OUTPUT_DIR/texts/"*.txt 2>/dev/null | sort -r)  # newest first
TOTAL=$(echo "$TEXTS" | grep -c . || echo 0)

if [ "$TOTAL" -eq 0 ]; then
    log "${GREEN}[batch]${NC} Nothing to process. All sessions already extracted."
    exit 0
fi

log "${GREEN}[batch]${NC} Processing $TOTAL sessions with $MAX_PARALLEL parallel workers"

RUNNING=0
DONE=0
FAILED=0

for txt_file in $TEXTS; do
    base=$(basename "$txt_file" .txt)

    for perspective in $PERSPECTIVES; do
        output_file="$OUTPUT_DIR/${base}.${perspective}.enox.jsonl"

        if [ -f "$output_file" ]; then
            continue
        fi

        # Wait if at max parallelism
        while [ $RUNNING -ge $MAX_PARALLEL ]; do
            wait -n 2>/dev/null || true
            RUNNING=$((RUNNING - 1))
        done

        # Launch extraction in background
        (
            log "${YELLOW}[extract]${NC} $base ($perspective)"
            if "$SCRIPT_DIR/extract.sh" "$txt_file" "$output_file" --perspective "$perspective" >> "$LOG_FILE" 2>&1; then
                # Load into graph
                if python3 "$SCRIPT_DIR/load.py" "$output_file" "$LOAD_URL" >> "$LOG_FILE" 2>&1; then
                    log "${GREEN}[done]${NC} $base ($perspective) — loaded"
                else
                    log "${RED}[fail]${NC} $base ($perspective) — load failed"
                fi
            else
                log "${RED}[fail]${NC} $base ($perspective) — extraction failed"
            fi
        ) &

        RUNNING=$((RUNNING + 1))
        DONE=$((DONE + 1))

        # Brief pause to avoid hammering the API
        sleep 2
    done
done

# Wait for all remaining
wait

log ""
log "${GREEN}[batch]${NC} Extraction complete. Processed: $DONE sessions"

# Step 3: Dedup sweep across federation
log "${GREEN}[batch]${NC} Running dedup sweep..."
# Dry run only — prints candidates, does NOT merge. Review manually then run with --apply
python3 "$SCRIPT_DIR/dedup-sweep.py" >> "$LOG_FILE" 2>&1 || true

# Step 4: Trigger backup snapshot
curl -sf -X POST "$LOAD_URL/api/export" > /dev/null 2>&1 || true
log "${GREEN}[batch]${NC} Snapshot saved"

# Final stats
NODES=$(curl -sf "$LOAD_URL/api/nodes" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo "?")
EDGES=$(curl -sf "$LOAD_URL/api/assertions" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo "?")
log "${GREEN}[batch]${NC} Final graph: $NODES nodes, $EDGES edges"
log "${GREEN}[batch]${NC} Check $LOG_FILE for details"
