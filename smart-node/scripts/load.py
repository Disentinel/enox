#!/usr/bin/env python3
"""Load ENOX JSONL into Smart Node with post-extraction dedup.

For each entity:
  1. Exact URI match → reuse
  2. Name search → if similar found, LLM Judge decides merge/keep
  3. Nothing → create new

Usage: python3 load.py <input.enox.jsonl> [base_url]
"""

import json
import os
import subprocess
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
        err = e.read().decode()
        try:
            return {"_error": True, "status": e.code, "parsed": json.loads(err)}
        except Exception:
            return {"_error": True, "status": e.code, "detail": err}
    except Exception as e:
        return {"_error": True, "detail": str(e)}


def search_existing(name, domain, base):
    """Search for existing entity by name words."""
    # Take first 2 significant words for search
    words = [w for w in name.lower().split() if len(w) > 2][:2]
    candidates = []
    for word in words:
        resp = api("GET", f"/api/nodes?q={urllib.request.quote(word)}", base=base)
        if resp and not isinstance(resp, dict):
            candidates.extend(resp)
        elif isinstance(resp, list):
            candidates.extend(resp)

    # Deduplicate candidates by id
    seen = set()
    unique = []
    for c in candidates:
        if isinstance(c, dict) and c.get("id") not in seen:
            seen.add(c["id"])
            unique.append(c)
    return unique


def llm_judge(new_entity, candidates):
    """Ask LLM whether new entity matches any candidate."""
    if not candidates:
        return None

    candidates_text = "\n".join(
        f"  {i+1}. [{c.get('domain','?')}] {c['id']} — {c['name']}: {c.get('description','')[:100]}"
        for i, c in enumerate(candidates[:5])
    )

    prompt = f"""You are an entity deduplication judge. Decide if a NEW entity is the same as any EXISTING entity.

NEW entity:
  Domain: {new_entity.get('domain', '?')}
  Name: {new_entity.get('label', '')}
  Description: {new_entity.get('description', '')}

EXISTING candidates:
{candidates_text}

Rules:
- SAME means they refer to the exact same concept/component/thing
- Different aspects of the same thing = SAME (e.g. "Knowledge Graph" and "Knowledge Graph System")
- Similar but distinct concepts = DIFFERENT (e.g. "AST Parser" and "Code Parser" are different tools)
- Different domains = almost certainly DIFFERENT

Reply with ONLY one line:
- "MATCH <number>" if it matches a candidate (e.g. "MATCH 1")
- "NEW" if it's a genuinely new entity"""

    try:
        result = subprocess.run(
            ["claude", "-p", "--model", "haiku", "--output-format", "text"],
            input=prompt, capture_output=True, text=True, timeout=30,
        )
        answer = result.stdout.strip().split("\n")[0].strip()
        if answer.startswith("MATCH"):
            idx = int(answer.split()[1]) - 1
            if 0 <= idx < len(candidates):
                return candidates[idx]["id"]
        return None
    except Exception:
        return None


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

    # Parse JSONL
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

    # Phase 1: Create/dedup nodes
    jsonl_id_to_api_id = {}
    created, matched, judged, failed = 0, 0, 0, 0

    for n in nodes:
        jsonl_id = n["id"]
        domain = n.get("domain", "cs")
        name = n.get("label", "")

        # Build expected URI
        if "/" in jsonl_id and not jsonl_id.startswith("enox://"):
            parts = jsonl_id.split("/")
            if len(parts) == 2:
                domain = parts[0]
        slug = name.lower().replace(" ", "_")
        slug = "".join(c for c in slug if c.isalnum() or c == "_").strip("_")
        expected_uri = f"{ENTITY_URI_PREFIX}/{domain}/{slug}"

        # Step 1: Exact URI match
        resp = api("GET", f"/api/nodes/{urllib.request.quote(expected_uri, safe='')}", base=base)
        if resp and not resp.get("_error"):
            jsonl_id_to_api_id[jsonl_id] = resp["id"]
            matched += 1
            continue

        # Step 2: Search by name
        candidates = search_existing(name, domain, base)

        if candidates:
            # Step 3: LLM Judge
            match_id = llm_judge(n, candidates)
            if match_id:
                jsonl_id_to_api_id[jsonl_id] = match_id
                judged += 1
                print(f"  MERGE: {jsonl_id} → {match_id}")
                continue

        # Step 4: Create new
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
            existing_id = resp.get("parsed", {}).get("id", expected_uri)
            jsonl_id_to_api_id[jsonl_id] = existing_id
            matched += 1
        else:
            failed += 1
            detail = str(resp.get("detail", resp.get("parsed", "?")))[:60] if resp else "?"
            print(f"  FAIL: {jsonl_id} — {detail}")

    print(f"[load] Nodes: {created} new, {matched} exact, {judged} merged, {failed} failed")

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
