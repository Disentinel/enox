---
name: enox-team-how-to-write
description: >
  Conventions for a TEAM sharing one Enox smart node: per-user attribution, a shared
  vocabulary of node/relation types, session anchoring, duplicate-avoidance, and what
  belongs in the shared graph vs. what doesn't. Use when onboarding a team to a shared
  Enox node, when multiple people/agents write to the same graph, or when deciding how
  to keep a collaborative knowledge graph coherent over time. Builds on the
  `enox-write-methodology` skill (read that first for the core write rules).
user_invocable: true
version: 1.0.0
---

# Enox Team How-To-Write

How a team keeps a **shared** Enox node coherent. This assumes everyone reads and
writes to one node. For the core write rules (atomic storage, context hygiene,
molecular validation), read `enox-write-methodology` first — this skill is about the
*collaboration* layer on top of it.

## 1. Identity is per-user — let the server set it

The node authenticates every request with a per-user bearer token, and every
assertion is attributed to the authenticated user (`asserted_by`).

- Each person and each agent gets their **own** token from the admin console
  (`/admin`). Don't share one token across the team — attribution becomes useless
  and you can't revoke a single leaked token.
- **Never override `asserted_by`** to write under someone else's name. The whole
  value of a shared graph is knowing who claimed what.
- System-generated edges (auto-dedup links, imports) are attributed to
  `system` / `dedup_worker`, not to a person — keep it that way.
- When two teammates disagree, that is **not** a conflict to resolve by overwrite.
  Two assertions with the same triple but different `asserted_by` and different
  confidence are both legitimate — the disagreement is data. Use `contradicts` to
  link them explicitly.

## 2. Agree on a vocabulary, write it down

The node is schemaless (`type` and `relation` are free strings), which is powerful
and dangerous: without agreement the graph fills with synonyms
(`depends_on` vs `requires` vs `needs`).

- Start from the server's **suggested** types (they appear in every tool's
  description) and only extend them when something genuinely doesn't fit.
- Keep a short, living **vocabulary note** (itself a node in the graph, e.g.
  `concept:team-vocabulary`) listing the node types and relations the team has
  agreed to use, with a one-line meaning for each. New members read it first.
- One spelling, one casing, per concept. Prefer `snake_case` relations and lowercase
  node types to match the suggested set.

## 3. Resolve to existing nodes — duplicates are the enemy

In a shared graph, the most common rot is the same entity created twice under
slightly different names.

- **Before creating a node, search** (`query_graph` / `semantic_search` /
  `explore`) for it and reuse the exact existing name.
- Use specific, stable names for shared entities (a component's real name, a
  decision's actual title) rather than ad-hoc phrasings.
- When you spot a duplicate pair, link them with `supersedes` (if one replaces the
  other) and migrate edges to the canonical node; don't leave two half-connected
  twins.

## 4. Anchor work to sessions

Anchor each chunk of work to a session node (`session:YYYY-MM-DD-topic`) and link
the assertions you wrote to it. This gives the team:

- **Provenance** — "which work produced this claim?"
- **Re-openability** — a later teammate can pick up the reasoning thread.
- **Review** — `recent_activity` plus session nodes make it easy to see what
  changed this week and by whom.

End a substantive session with a short `about` edge from the session to the concept
it produced.

## 5. What belongs in the shared graph

Write things that are **durable, team-relevant, and not derivable in one hop**:

- Decisions and the alternatives they rejected (with the *why* in `context`).
- Architectural facts: what depends on / implements / supersedes what.
- Recurring patterns, conventions, and the rationale behind them.
- Cross-references to external artifacts (PRs, docs, tickets) via `references`.

Do **not** write: transient chat, personal notes, secrets/credentials, or anything
private to one person. A shared node is read by the whole team — treat every write
as something a teammate (or an agent acting for them) will rely on.

## 6. Quality bar before committing a batch

1. Each edge is **atomic** (one fact) and **attributed** to the right user.
2. Targets resolve to **existing canonical nodes** (you searched first).
3. `context` explains what the triple doesn't, in specific terms (so semantic search
   finds it).
4. Types/relations come from the **agreed vocabulary**.
5. Contradictions with existing edges are **surfaced**, not overwritten.
6. The batch is **anchored to a session**.

If all six hold, write with `batch_assertions` (keep batches modest, e.g. ≤50 per
call). Afterwards, `explore` a couple of the touched entities to confirm the edges
landed on the canonical nodes and read coherently.
