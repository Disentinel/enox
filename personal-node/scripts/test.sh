#!/usr/bin/env bash
# Runs each *.test.ts file in its own process with its own throwaway temp data
# directory, so tests never touch the real data/ directory and can't leak state
# between files (KuzuDB doesn't support concurrent multi-process access to the
# same store, so isolation is per-process, not just per-env-var).
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0
TEST_FILES=$(find src -name '*.test.ts' | sort)

if [ -z "$TEST_FILES" ]; then
  echo "No *.test.ts files found under src/"
  exit 0
fi

for f in $TEST_FILES; do
  echo "=== $f ==="
  TMP=$(mktemp -d)
  KUZU_DB_PATH="$TMP/enox.db" \
  SQLITE_PATH="$TMP/enox-meta.sqlite" \
  AUTH_TOKEN="test-secret-token" \
  PUBLIC_BASE_URL="https://test.example.org" \
  NODE_NAME="test-node" \
  npx tsx --test "$f" || FAIL=1
  rm -rf "$TMP"
done

exit $FAIL
