# Knowledge Pipeline — Reference & Best Practices

**This is not a pipeline to install verbatim.** It's a menu of building blocks and best practices.
Claude Code should read it, run a short interview with the operator, and then implement *only the
subset that fits them*. Different teams want very different loops; the wrong default is worse than
asking.

---

## How Claude Code should use this file

1. Read the whole thing first.
2. Run the interview below (keep it to these questions — don't over-ask).
3. Implement the chosen subset against the node's MCP/HTTP API, using the user's token (so
   `asserted_by` is set automatically). Show the user what you're about to wire up before writing
   hooks or editing `CLAUDE.md`.
4. End with a one-line summary of the loop you built and how to turn each piece off.

### Interview (ask, then implement)

- **Read, write, or both?** Inject graph context into sessions (read), capture knowledge back
  (write), or the full loop?
- **Sources?** Chat/session exports, repo (commits/PRs), docs folder, incident reports, manual only?
- **Cadence?** Manual capture, per-session automation (hooks), or scheduled jobs (cron/CI)?
- **Who extracts?** The local `claude` CLI on each host, a server-side extractor, or Claude Code
  inline during normal work?
- **One language for entity names?** (Cross-language dedup does not work — pick one and enforce it.)

---

## The loop

Four phases plus the cadence that makes them recurring:

```
   EXTRACTION ──▶ POPULATION ──▶ LINKING ──▶ VERIFICATION
       ▲                                          │
       └────────────── CADENCE ◀──────────────────┘
```

### 1. Extraction — text → candidate assertions

Turn raw material into atomic candidate facts. Best practices:

- **Interrogate, don't transcribe.** The goal isn't "summarize the text," it's "what relations does
  this text assert?" Pull `(source, relation, target)` triples, not prose.
- **Chunk with overlap.** ~4000 chars with ~500 overlap is a sane default, but know the failure
  mode: a reasoning chain `A → B → C → conclusion` split across a chunk boundary loses the causal
  link. For decision/causal text, prefer fewer, larger chunks or section-aware splitting.
- **Extract by perspective, separately.** Run distinct passes for *knowledge* (structural facts),
  *temporal* (what happened when), and *opinions* (who prefers/distrusts/values what). Mixing them
  in one prompt produces mush. The node is schemaless, so you're free on node/relation names — but
  pick a consistent vocabulary per team and write it down.
- **Extraction is deliberately dumb.** Do **not** try to dedup or link during extraction. Emit
  candidates; linking is a separate phase with the existing graph in view.

**Mechanism options (pick one in the interview):**
- *Local `claude` CLI* — a prompt template piped through `claude -p`. Simplest, but adds a hard
  per-host dependency on the CLI being installed and authed. Document it if chosen.
- *Server-side extractor* — an endpoint on the node does extraction. No per-host dependency; better
  for a team. More to build.
- *Inline during work* — Claude Code extracts as a side effect of normal sessions and writes via
  MCP. Lowest setup, best signal-to-noise (only real working knowledge lands), no batch backfill.

### 2. Population — candidates → into the graph

Write through the node's MCP tools so the **token sets `asserted_by` automatically**. Best practices:

- **Atomic storage.** One fact per assertion. "X depends on A and B" is two writes.
- **Honest confidence.** Map to bands, don't default to 1.0: ~0.3 unverified/just-extracted, ~0.7 a
  human who owns the area confirmed it, ~0.9+ corroborated. Confidence is a 3-band signal, not a
  probability.
- **Context hygiene.** The `context` field carries what the triple can't: *why* it holds, under what
  conditions, what was true at the time. Never restate the triple. Write for a reader with no
  background.
- **Anchor to a session.** Create a session node per batch/working session and link what you produce
  to it, so provenance is traceable ("where did this come from").
- **Idempotency.** Exact duplicates collapse on `fact_id = SHA256(source+relation+target)`. Lean on
  that; don't write defensive guards for exact dups.

### 3. Linking — connect new knowledge into the existing graph

This is the phase people skip, and it's where the graph stops being a pile and becomes a graph.

- **Find the attachment points first.** Before/after population, use `semantic_search` / `traverse`
  / `query_graph` to locate the existing nodes the new knowledge should connect to. An island node
  is a smell.
- **Record contradictions, don't resolve them silently.** With multi-user writes, two people will
  assert conflicting things. That's signal — write an explicit `contradicts` edge with both
  authors' context. Never overwrite someone else's assertion to "fix" a disagreement.
- **Fuzzy-dedup sweep.** Exact-URI dedup is automatic; near-duplicates are not ("Auth Service" vs
  "auth-service", or two languages). Run a periodic LLM-judge pass to merge near-dupes. Best
  defense is upstream: **one language, agreed canonical names.**
- **Corroborate, don't duplicate.** If a fact is already there, raise its confidence/proof_depth
  instead of adding a second edge.

### 4. Verification — keep it true

- **Promote confidence as reality confirms it.** Extracted (0.3) → a teammate confirms (0.7) →
  multiple confirm or it's checked against the system (0.9+).
- **Completeness audits.** A `decision` node with no "why" (a rejected-alternative or a reason
  edge) is half-recorded. Flag incompletes as known-unknowns rather than pretending they're whole.
- **Staleness & orphans.** Periodically surface assertions that haven't been touched since a
  relevant change, and orphan nodes with no edges.
- **Treat the graph as a map, not the territory.** It's for *finding* and *remembering*; verify
  against the real source before acting on anything high-stakes.

---

## Cadence — making the loop recurring

This is the part that turns a one-off import into a living graph. Three layers, lowest-friction first:

### CLAUDE.md (start here — zero infra)

Add standing instructions so every Claude Code session naturally:
- queries the graph for relevant context **before** answering a "why/what/who" question, and
- at the end of substantive work, writes back new decisions, dependencies, and rejected
  alternatives as atomic assertions anchored to the session.

This alone gives you a regular extract→populate loop with no hooks or jobs.

### Hooks (per-session automation)

Claude Code hooks run on session events. Confirm exact event names against current Claude Code docs
when implementing; the useful shapes here are:

| Goal | Hook (behavior) | What it does |
|------|-----------------|--------------|
| RAG read-path | on prompt submit | Query the node for a budgeted relevant subgraph and inject it as context (the "graph-aware RAG" pattern). Keep a token budget (~1.5K) so it doesn't crowd the prompt. |
| Session warm-up | on session start | Load the session's anchor node + recent related decisions. |
| Capture nudge | on stop / session end | Prompt to record what was decided/learned this session. |
| Commit-triggered extract | after a git commit / PR tool | Extract relations from the diff + message and queue them for population. |

Ship hooks as small scripts that hit the node's HTTP/MCP API **with the user's token** (so
attribution is correct and access is scoped). Fail open and silent — a hook that errors must never
block the user's prompt.

### Scheduled jobs (cron / CI)

- Periodic **fuzzy-dedup sweep** + **verification audit** (completeness, staleness, unresolved
  contradictions).
- Optional **batch backfill** from a docs folder or PR stream — only if the team actually wants
  historical import; inline capture usually beats backfill on signal quality.

---

## Three starting presets (offer one)

- **Minimal / manual** — CLAUDE.md instructions only. No hooks, no jobs. Read + write by hand.
  Good for a skeptical team testing the idea.
- **RAG read-only** — UserPromptSubmit hook injects context; writes stay manual via MCP. Good when
  the graph already has content and you want it *used* before you invest in capture automation.
- **Full auto loop** — CLAUDE.md + read hook + capture nudge + a weekly dedup/verify job. Only after
  the team has bought in; automation on an untrusted graph just scales the noise.

---

## Anti-patterns (don't)

- **Auto-extract raw transcripts at scale on day one.** You'll manufacture noise with arbitrary
  confidence and lose the team's trust in a week. Start narrow and real.
- **Dedup or link during extraction.** Separate phases; linking needs the existing graph in view.
- **Silent overwrite of someone's assertion.** Disagreement is data — record it.
- **Mixed-language entity names.** Forks every concept into unmergeable twins.
- **Hooks that block or spam.** Fail open, stay under budget, no chatter on every prompt.
- **Trusting confidence numbers as probabilities.** They're a 3-band signal at best.
