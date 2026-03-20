#!/bin/bash
# KDL extraction check — called from UserPromptSubmit hook
# Checks if enough new messages have accumulated to warrant extraction
# Outputs a system reminder if extraction is due

SMART_NODE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MARKER_DIR="$SMART_NODE_DIR/.kdl-markers"
mkdir -p "$MARKER_DIR"

# Find current session JSONL (most recently modified)
SESSION_DIR="$HOME/.claude/projects/YOUR_PROJECT_PATH"
CURRENT_SESSION=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)

if [ -z "$CURRENT_SESSION" ] || [ ! -f "$CURRENT_SESSION" ]; then
    exit 0  # No session found, skip silently
fi

SESSION_ID=$(basename "$CURRENT_SESSION" .jsonl)
MARKER="$MARKER_DIR/$SESSION_ID"
THRESHOLD=30  # messages between extractions

# Count lines (approximate message count)
MSG_COUNT=$(wc -l < "$CURRENT_SESSION" 2>/dev/null | tr -d ' ')
LAST_COUNT=$(cat "$MARKER" 2>/dev/null || echo "0")
DELTA=$((MSG_COUNT - LAST_COUNT))

if [ "$DELTA" -gt "$THRESHOLD" ]; then
    # Check if smart-node server is running
    if curl -sf http://localhost:3700/health > /dev/null 2>&1; then
        NODE_COUNT=$(curl -sf http://localhost:3700/api/nodes | python3 -c "import sys,json; print(len(json.loads(sys.stdin.readline())))" 2>/dev/null || echo "?")
        cat << EOF
[KDL] $DELTA new messages since last extraction (graph has $NODE_COUNT nodes).
Consider extracting knowledge from this session. The session file is at: $CURRENT_SESSION
EOF
        # Update marker so we don't remind again until next threshold
        echo "$MSG_COUNT" > "$MARKER"
    fi
fi
