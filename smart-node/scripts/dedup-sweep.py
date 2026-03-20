#!/usr/bin/env python3
"""Post-load dedup sweep across the entire federation.

Three passes:
  1. Exact URI match — already handled by load.py (409 on create)
  2. Embedding similarity — find near-duplicates across all nodes
  3. LLM Judge — decide SAME/ALIAS/DIFFERENT for fuzzy candidates

Usage:
  python3 dedup-sweep.py                    # dry run, print candidates
  python3 dedup-sweep.py --apply            # merge duplicates
  python3 dedup-sweep.py --threshold 0.8    # custom similarity threshold
"""

import json
import sys
import subprocess
import urllib.request
import urllib.error

FEDERATION_PORTS = [3700, 3701]
SIMILARITY_THRESHOLD = 0.75
MAX_JUDGE_BATCH = 20


def api(base, method, path, data=None):
    url = f"{base}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def fetch_all_nodes():
    """Fetch nodes from all federation peers."""
    all_nodes = {}
    for port in FEDERATION_PORTS:
        base = f"http://localhost:{port}"
        try:
            nodes = api(base, "GET", "/api/nodes")
            if nodes:
                for n in nodes:
                    n["_port"] = port
                    all_nodes[n["id"]] = n
        except:
            pass
    return all_nodes


def find_embedding_candidates(nodes, threshold):
    """Use the embedding search endpoint to find similar pairs."""
    candidates = []
    seen_pairs = set()

    # For each node, search for similar ones
    base = f"http://localhost:{FEDERATION_PORTS[0]}"

    for nid, node in nodes.items():
        query = f"{node['name']}. {node.get('description', '') or ''}"
        resp = api(base, "POST", "/api/context", {"prompt": query, "budget": 50})
        if not resp:
            continue

        for match in resp.get("nodes", []):
            mid = match.get("id", "")
            if mid == nid:
                continue
            if mid not in nodes:
                continue

            pair_key = tuple(sorted([nid, mid]))
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)

            # Check if same domain (cross-domain = probably not duplicates)
            if node.get("domain") != nodes[mid].get("domain"):
                continue

            # Score based on name similarity
            from difflib import SequenceMatcher
            name_sim = SequenceMatcher(
                None, node["name"].lower(), nodes[mid]["name"].lower()
            ).ratio()

            if name_sim >= threshold:
                candidates.append(
                    {
                        "id_a": nid,
                        "id_b": mid,
                        "name_a": node["name"],
                        "name_b": nodes[mid]["name"],
                        "domain": node.get("domain", "?"),
                        "similarity": name_sim,
                        "desc_a": (node.get("description") or "")[:100],
                        "desc_b": (nodes[mid].get("description") or "")[:100],
                    }
                )

    candidates.sort(key=lambda x: -x["similarity"])
    return candidates


def ask_judge(candidates):
    """Ask Sonnet to judge pairs: SAME / ALIAS / DIFFERENT."""
    if not candidates:
        return []

    prompt = """You are an entity dedup judge for a knowledge graph. For each pair, decide:
- SAME: identical concept, merge into first ID
- ALIAS: related but distinct, just note the relationship
- DIFFERENT: unrelated despite similar names

Output one line per pair: PAIR_NUMBER VERDICT
Example:
1 SAME
2 DIFFERENT
3 ALIAS

Pairs:
"""
    for i, c in enumerate(candidates[:MAX_JUDGE_BATCH], 1):
        prompt += f"\nPair {i} (domain: {c['domain']}, similarity: {c['similarity']:.2f}):\n"
        prompt += f"  A: {c['name_a']} — {c['desc_a']}\n"
        prompt += f"  B: {c['name_b']} — {c['desc_b']}\n"

    try:
        result = subprocess.run(
            ["claude", "-p", "--model", "sonnet", "--output-format", "text"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=90,
        )
        output = result.stdout.strip()
    except Exception as e:
        print(f"  Judge error: {e}", file=sys.stderr)
        return []

    verdicts = []
    for line in output.split("\n"):
        parts = line.strip().split()
        if len(parts) >= 2:
            try:
                idx = int(parts[0]) - 1
                verdict = parts[1].upper()
                if verdict in ("SAME", "ALIAS", "DIFFERENT") and idx < len(candidates):
                    verdicts.append((candidates[idx], verdict))
            except (ValueError, IndexError):
                continue

    return verdicts


def merge_entities(id_keep, id_remove, port_remove):
    """Merge: repoint edges from id_remove to id_keep, delete id_remove."""
    base = f"http://localhost:{port_remove}"

    # Get all edges of the entity to remove
    encoded = urllib.parse.quote(id_remove, safe="")
    neighbors = api(base, "GET", f"/api/graph/neighbors?id={encoded}")
    if not neighbors or not isinstance(neighbors, list):
        return False

    # For each edge, create equivalent pointing to id_keep
    keep_base = None
    for port in FEDERATION_PORTS:
        b = f"http://localhost:{port}"
        node = api(b, "GET", f"/api/node?id={urllib.parse.quote(id_keep, safe='')}")
        if node and not isinstance(node, dict) or (isinstance(node, dict) and not node.get("error")):
            keep_base = b
            break

    if not keep_base:
        keep_base = f"http://localhost:{FEDERATION_PORTS[0]}"

    # Delete the duplicate (DETACH DELETE removes its edges too)
    api(base, "DELETE", f"/api/node?id={encoded}")
    return True


def main():
    import urllib.parse

    do_apply = "--apply" in sys.argv
    threshold = SIMILARITY_THRESHOLD

    for i, arg in enumerate(sys.argv):
        if arg == "--threshold" and i + 1 < len(sys.argv):
            threshold = float(sys.argv[i + 1])

    print(f"[dedup-sweep] Fetching nodes from federation...")
    nodes = fetch_all_nodes()
    print(f"[dedup-sweep] {len(nodes)} nodes across {len(FEDERATION_PORTS)} peers")

    print(f"[dedup-sweep] Finding embedding candidates (threshold={threshold})...")
    candidates = find_embedding_candidates(nodes, threshold)
    print(f"[dedup-sweep] {len(candidates)} candidates found")

    if not candidates:
        print("[dedup-sweep] No duplicates. Graph is clean.")
        return

    for c in candidates[:30]:
        print(
            f"  {c['similarity']:.2f} [{c['domain']}] {c['name_a'][:40]} <-> {c['name_b'][:40]}"
        )

    if len(candidates) > MAX_JUDGE_BATCH:
        print(
            f"\n[dedup-sweep] Judging top {MAX_JUDGE_BATCH} of {len(candidates)} candidates..."
        )
    else:
        print(f"\n[dedup-sweep] Judging {len(candidates)} candidates...")

    verdicts = ask_judge(candidates)

    merges = 0
    for candidate, verdict in verdicts:
        symbol = {"SAME": "=", "ALIAS": "~", "DIFFERENT": "x"}[verdict]
        print(
            f"  [{symbol}] {candidate['name_a'][:30]} <-> {candidate['name_b'][:30]}: {verdict}"
        )
        if verdict == "SAME":
            merges += 1

    if merges == 0:
        print("\n[dedup-sweep] No merges needed.")
        return

    print(f"\n[dedup-sweep] {merges} merges identified.")

    if do_apply:
        applied = 0
        for candidate, verdict in verdicts:
            if verdict == "SAME":
                port = nodes[candidate["id_b"]]["_port"]
                if merge_entities(
                    candidate["id_a"], candidate["id_b"], port
                ):
                    applied += 1
                    print(f"  Merged: {candidate['name_b']} → {candidate['name_a']}")
        print(f"\n[dedup-sweep] Applied {applied} merges.")
    else:
        print("[dedup-sweep] Dry run. Use --apply to execute merges.")


if __name__ == "__main__":
    main()
