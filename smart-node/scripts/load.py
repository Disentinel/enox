#!/usr/bin/env python3
"""Load ENOX JSONL into Smart Node.

Dedup: exact URI match only (fast, no LLM).
Fuzzy dedup via LLM judge is a separate sweep step.

Usage: python3 load.py <input.enox.jsonl> [base_url]
"""

import json
import os
import sys
import urllib.request
import urllib.error

ENTITY_URI_PREFIX = os.environ.get('NODE_URI_PREFIX', 'enox://enox.dev/personal/vadim_r')


def api(method, path, data=None, base="http://localhost:3700"):
    url = f"{base}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return {"_error": True, "status": e.code, "parsed": json.loads(e.read().decode())}
        except Exception:
            return {"_error": True, "status": e.code}
    except Exception as e:
        return {"_error": True, "detail": str(e)}


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 load.py <input.enox.jsonl> [base_url]")
        sys.exit(1)

    input_file = sys.argv[1]
    base = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:3700"

    health = api("GET", "/health", base=base)
    if not health or (isinstance(health, dict) and health.get("_error")):
        print(f"Server not reachable at {base}")
        sys.exit(1)

    nodes, edges = [], []
    with open(input_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj["_type"] == "node":
                nodes.append(obj)
            elif obj["_type"] == "edge":
                edges.append(obj)

    print(f"[load] {len(nodes)} nodes, {len(edges)} edges from {input_file}")

    # Phase 1: Create nodes — exact URI dedup only
    jsonl_id_to_api_id = {}
    created, existed, failed = 0, 0, 0

    for n in nodes:
        jsonl_id = n["id"]
        domain = n.get("domain", "cs")
        name = n.get("label", "")
        slug = name.lower().replace(" ", "_")
        slug = "".join(c for c in slug if c.isalnum() or c == "_").strip("_")

        payload = {
            "type": n.get("node_type", "concept"),
            "domain": domain,
            "name": name,
            "description": n.get("description", ""),
            "aliases": n.get("aliases", []),
        }
        resp = api("POST", "/api/nodes", payload, base)

        if resp and not resp.get("_error"):
            jsonl_id_to_api_id[jsonl_id] = resp["id"]
            created += 1
        elif resp and resp.get("status") == 409:
            # Already exists — reconstruct URI
            existing_id = resp.get("parsed", {}).get("id", "")
            if not existing_id:
                existing_id = f"{ENTITY_URI_PREFIX}/{domain}/{slug}"
            jsonl_id_to_api_id[jsonl_id] = existing_id
            existed += 1
        else:
            failed += 1
            detail = str(resp)[:60] if resp else "?"
            print(f"  FAIL: {jsonl_id} — {detail}")

    print(f"[load] Nodes: {created} new, {existed} existed, {failed} failed")

    # Phase 2: Create assertions
    edge_ok, edge_existed, edge_fail, edge_skip = 0, 0, 0, 0

    for e in edges:
        src_id = jsonl_id_to_api_id.get(e["from"])
        tgt_id = jsonl_id_to_api_id.get(e["to"])

        if not src_id or not tgt_id:
            edge_skip += 1
            continue

        payload = {
            "source": src_id,
            "target": tgt_id,
            "relation": e["rel"],
            "confidence": e.get("confidence", 1.0),
            "context": e.get("context", ""),
        }
        resp = api("POST", "/api/assertions", payload, base)
        if resp and not resp.get("_error"):
            edge_ok += 1
        elif resp and resp.get("status") == 409:
            edge_existed += 1
        else:
            edge_fail += 1

    print(f"[load] Edges: {edge_ok} new, {edge_existed} existed, {edge_fail} failed, {edge_skip} skipped")
    print(f"[load] Done. Graph at {base}")


if __name__ == "__main__":
    main()
