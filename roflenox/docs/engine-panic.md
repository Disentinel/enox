# rofl-serve panic seen from ROFLENOX (for the engine's owner)

**What:** `rofl-serve` exited with code 101 (a Rust panic) while ROFLENOX was
rebuilding a node's world from its log. No personal data is needed to reproduce
this; the facts below are counts, paths and stack lines only.

**Binary:** `~/rofl-rust/rust/target/release/rofl-serve`, branch `spat-rust`,
commit `ee6aaac` (built 2026-09-26 13:30), driven through `runtime/port.ts` from
rofl `origin/main` 9a3ca79.

**Panic lines (two runs, different places):**

    thread 'main' panicked at rofl/src/store.rs:211:19:
    slice index starts at 1908669 but ends at 1904580

    thread 'main' panicked at rofl/src/store.rs:985:34:

**The request pattern that was running** (one `rofl-serve` process, one
session chain, 82 rounds, one per batch):

    fresh
    repeat 82×:  fork(S) → load(rules, who="roflenox")      (first batch of an identity only)
                           load(<≈2000 facts>, who=<identity>)
                           load(loaded_batch fact, who="roflenox")
                           evaluate
                           → the fork becomes S; close(old S)
    ask …

The world at the end: ≈162 000 base facts (+ ≈162 000 `asserted` rows and the
system views over them: `superseded`/`current`/`view`/`exported`), one book,
~15 per-book system rules including one with negation (`current` uses
`not superseded`) and comparisons (`S1 < S2`, `T < U`).

**Frequency:** on the real data, 2 of 3 runs of that pattern panicked, the
third completed; on synthetic data, 1 of 3 (below). The same world loaded with **one** session and one `evaluate` at the
end (no fork per batch) completed 3 of 3.

**Hypothesis (unverified):** state shared between a fork and its parent — an
index or slice offset computed on one and applied after `close()` of the other.
Every panic happened after many fork/close cycles, never in the single-session
path.

**What ROFLENOX does about it (r_engine_crash_recovery):** replay uses the
single-session path; admission still forks per batch, so a crash there refuses
the batch (503 `engine_down`, the log untouched) and the node rebuilds the
engine from what it holds on the next request. See
`test/durability.test.ts` — "killing the engine during an admission leaves the
log consistent, refuses that batch, and the node answers after it rebuilds".

**Reproduced on synthetic data (2026-09-27):** `scripts/engine-panic-repro.ts`
(generator `test/perf/gen.ts`, 160 000 facts in batches of 2000, 85 relations,
system rules from `bookRules`), three runs of the fork-per-batch loop:

    {"run":0,"batches":80,"seconds":353.9,"panic":null}
    {"run":1,"batches":80,"seconds":299.7,"panic":null}
    {"run":2,"batches":49,"seconds":118.1,"panic":"… panicked at rofl/src/store.rs:985:34:"}

So it is not data-specific: ~1 in 3 runs, at a varying point (batch 49 here,
≈98 000 facts held). Run: `node --experimental-strip-types scripts/engine-panic-repro.ts 3 160000`.

**To reproduce by hand:** generate ≈160 000 synthetic facts in
batches of 2000 (e.g. `edge[b_x]("f<i>", "s<i>", "r<i%85>", "t<i>")` plus
`asserted[b_x]("f<i>", "p", 900, <batch#>)`), load the system rules of
`src/engine.ts: bookRules`, and run the fork-per-batch loop above; repeat 3×.
(ROFLENOX's synthetic generator for r_snapshot_is_cache produces this shape.)
