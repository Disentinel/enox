#!/usr/bin/env python3
"""LLM Judge for fuzzy entity dedup.

Two-pass:
  Pass 1: deterministic — exact URI match (already handled by load.py)
  Pass 2: fuzzy — find candidates by slug similarity, ask Sonnet to judge

Usage: python3 dedup-judge.py <file1.enox.jsonl> <file2.enox.jsonl> [--apply]
       python3 dedup-judge.py <dir_with_jsonl_files> [--apply]

Without --apply: prints merge suggestions.
With --apply: rewrites file2 with merged IDs.
"""

import json
import sys
import subprocess
import os
from difflib import SequenceMatcher

def load_entities(path):
    entities = {}
    with open(path) as f:
        for line in f:
            obj = json.loads(line.strip())
            if obj.get("_type") == "node":
                entities[obj["id"]] = obj
    return entities

def slug(entity_id):
    """Extract entity slug (last part of ID)."""
    return entity_id.split("/")[-1]

def domain(entity_id):
    """Extract domain from ID."""
    parts = entity_id.split("/")
    return parts[0] if len(parts) >= 2 else ""

def find_fuzzy_candidates(entities_a, entities_b, threshold=0.7):
    """Find pairs that might be the same entity across files."""
    candidates = []

    for id_a, node_a in entities_a.items():
        for id_b, node_b in entities_b.items():
            if id_a == id_b:
                continue  # exact match, already handled

            slug_a = slug(id_a)
            slug_b = slug(id_b)
            name_a = node_a.get("label", "").lower()
            name_b = node_b.get("label", "").lower()

            # Check slug similarity
            slug_sim = SequenceMatcher(None, slug_a, slug_b).ratio()

            # Check name similarity
            name_sim = SequenceMatcher(None, name_a, name_b).ratio()

            # Check if one name contains the other
            contains = name_a in name_b or name_b in name_a

            # Check alias overlap
            aliases_a = set(a.lower() for a in node_a.get("aliases", []))
            aliases_b = set(b.lower() for b in node_b.get("aliases", []))
            alias_overlap = bool(aliases_a & aliases_b) or name_a in aliases_b or name_b in aliases_a

            if slug_sim > threshold or name_sim > threshold or contains or alias_overlap:
                score = max(slug_sim, name_sim)
                if contains:
                    score = max(score, 0.8)
                if alias_overlap:
                    score = max(score, 0.85)
                candidates.append((id_a, id_b, score, node_a, node_b))

    # Sort by similarity descending
    candidates.sort(key=lambda x: -x[2])
    return candidates

def ask_judge(pairs):
    """Ask Sonnet to judge each pair: SAME / DIFFERENT / ALIAS."""
    if not pairs:
        return []

    prompt = """You are an entity dedup judge. For each pair below, decide:
- SAME: these are the same concept, merge into the first ID
- ALIAS: related but distinct, add as alias only
- DIFFERENT: unrelated, keep separate

Output one line per pair: PAIR_NUMBER VERDICT
Example: 1 SAME
         2 DIFFERENT

Pairs:
"""
    for i, (id_a, id_b, score, node_a, node_b) in enumerate(pairs, 1):
        prompt += f"""
Pair {i} (similarity {score:.2f}):
  A: {id_a} — "{node_a.get('label', '')}" — {node_a.get('description', '')[:100]}
  B: {id_b} — "{node_b.get('label', '')}" — {node_b.get('description', '')[:100]}
"""

    try:
        result = subprocess.run(
            ["claude", "-p", "--model", "sonnet", "--output-format", "text"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout.strip()
    except Exception as e:
        print(f"  Judge error: {e}", file=sys.stderr)
        return [(id_a, id_b, "DIFFERENT") for id_a, id_b, *_ in pairs]

    verdicts = []
    for line in output.split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2:
            try:
                idx = int(parts[0]) - 1
                verdict = parts[1].upper()
                if verdict in ("SAME", "ALIAS", "DIFFERENT") and idx < len(pairs):
                    id_a, id_b = pairs[idx][0], pairs[idx][1]
                    verdicts.append((id_a, id_b, verdict))
            except (ValueError, IndexError):
                continue

    return verdicts

def apply_merges(file_path, merges):
    """Rewrite JSONL file, replacing merged IDs."""
    id_map = {}
    for id_a, id_b, verdict in merges:
        if verdict == "SAME":
            id_map[id_b] = id_a  # B merges into A

    if not id_map:
        return 0

    lines = []
    removed = 0
    with open(file_path) as f:
        for line in f:
            obj = json.loads(line.strip())
            if obj.get("_type") == "node" and obj["id"] in id_map:
                removed += 1
                continue  # skip merged node
            if obj.get("_type") == "edge":
                if obj["from"] in id_map:
                    obj["from"] = id_map[obj["from"]]
                if obj["to"] in id_map:
                    obj["to"] = id_map[obj["to"]]
            lines.append(json.dumps(obj, ensure_ascii=False) + "\n")

    with open(file_path, "w") as f:
        f.writelines(lines)

    return removed

def main():
    args = [a for a in sys.argv[1:] if a != "--apply"]
    do_apply = "--apply" in sys.argv

    if len(args) == 1 and os.path.isdir(args[0]):
        files = sorted(f for f in os.listdir(args[0]) if f.endswith(".enox.jsonl"))
        files = [os.path.join(args[0], f) for f in files]
    elif len(args) == 2:
        files = args
    else:
        print("Usage: python3 dedup-judge.py <file1.jsonl> <file2.jsonl> [--apply]")
        print("       python3 dedup-judge.py <dir> [--apply]")
        sys.exit(1)

    # Load all entities
    all_entities = {}
    file_entities = {}
    for f in files:
        ents = load_entities(f)
        file_entities[f] = ents
        all_entities.update(ents)

    print(f"[dedup] {len(files)} files, {len(all_entities)} total entities")

    # Find fuzzy candidates across all file pairs
    all_candidates = []
    for i, f1 in enumerate(files):
        for f2 in files[i + 1:]:
            candidates = find_fuzzy_candidates(file_entities[f1], file_entities[f2])
            if candidates:
                all_candidates.extend(candidates)

    if not all_candidates:
        print("[dedup] No fuzzy candidates found. Graph is clean.")
        return

    print(f"[dedup] {len(all_candidates)} fuzzy candidates found:")
    for id_a, id_b, score, node_a, node_b in all_candidates:
        print(f"  {score:.2f}  {id_a} <-> {id_b}")

    # Ask LLM Judge
    print(f"\n[dedup] Asking Sonnet to judge {len(all_candidates)} pairs...")
    verdicts = ask_judge(all_candidates)

    for id_a, id_b, verdict in verdicts:
        symbol = {"SAME": "=", "ALIAS": "~", "DIFFERENT": "x"}[verdict]
        print(f"  [{symbol}] {id_a} <-> {id_b}: {verdict}")

    merges = [(a, b, v) for a, b, v in verdicts if v == "SAME"]
    if not merges:
        print("\n[dedup] No merges needed.")
        return

    if do_apply:
        for f in files[1:]:  # Apply to all but the first (canonical)
            removed = apply_merges(f, merges)
            if removed:
                print(f"\n[dedup] Applied {removed} merges to {f}")
    else:
        print(f"\n[dedup] {len(merges)} merges suggested. Run with --apply to execute.")

if __name__ == "__main__":
    main()
