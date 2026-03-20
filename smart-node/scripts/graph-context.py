#!/usr/bin/env python3
"""Graph context hook — injects relevant subgraph into Claude's context.

Receives JSON on stdin: {prompt, session_id, cwd, ...}
Outputs formatted context to stdout (becomes system-reminder).
"""

import sys
import json
import urllib.request
import urllib.error

SMART_NODE = "http://localhost:3700"
TOKEN_BUDGET = 1500

def main():
    # Check server
    try:
        urllib.request.urlopen(f"{SMART_NODE}/health", timeout=2)
    except:
        return

    # Read hook input
    try:
        raw = sys.stdin.read()
        hook_input = json.loads(raw)
    except:
        return

    prompt = hook_input.get("prompt", "")
    if not prompt or len(prompt) < 5:
        return

    # Query context endpoint
    try:
        body = json.dumps({"prompt": prompt, "budget": TOKEN_BUDGET}).encode()
        req = urllib.request.Request(
            f"{SMART_NODE}/api/context",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except:
        return

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    overflow = data.get("overflow", 0)

    if not nodes:
        return

    print("[ENOX Graph Context]")
    for n in nodes:
        desc = f' — {n["description"]}' if n.get("description") else ""
        print(f'  {n["name"]} ({n["type"]}, {n.get("domain", "?")}){desc}')

    if edges:
        print("  Connections:")
        for e in edges:
            print(f'    {e["source_name"]} --[{e["relation"]}]--> {e["target_name"]} ({e["confidence"]})')

    if overflow:
        print(f"  [{overflow} more — use query_graph MCP tool to explore]")

if __name__ == "__main__":
    main()
