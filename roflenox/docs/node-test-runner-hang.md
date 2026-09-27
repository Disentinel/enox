# Node 22's test runner can hang on a failing test's output

**Symptom.** A `node --test` run never finishes: `--test-timeout` does not
fire, SIGTERM does not stop it, and the process sits at 100 % CPU. In the
mutation gate this showed up as `NOTRUN` for one mutant, and as a run cut off
by the 240 s wall that pushed the gate past its 300 s budget.

**Where it spins.** Not in the code under test. A V8 tick profile
(`node --prof`, then `node --prof-process`) of the hung process puts almost all
of the time in the RUNNER, parsing the test child's stdout:

```
#processRawBuffer   node:internal/test_runner/runner:301
#drainRawBuffer     node:internal/test_runner/runner:296
drain / report / finalize   node:internal/test_runner/...
```

`sample <pid>` (macOS) shows the same thing from the outside: the event loop
is inside a stream-shutdown callback running microtasks without end, so no
timer (and so no `--test-timeout`) ever runs.

**Trigger.** A multi-byte UTF-8 character that straddles two chunks of the
child's output. The failing test here was the mutant M102 ("a dead engine is
never rebuilt"): its assertion diff repeats the refusal message
`… rebuilt from the log — send it again` eight times, and the em dash (3 bytes)
sometimes lands on a chunk boundary.

**Measured** (Node v22.22.0, macOS x64, the same mutated tree, repeated runs):

| run mode | hung |
|---|---|
| `node --test` (a child process per file — the default) | 11 of 20 |
| the same, with the em dash in the message replaced by `;` | 0 of 24 |
| `node --test --experimental-test-isolation=none` (in-process) | 0 of 30 |
| the unmutated code (the test passes; the diff is never printed) | 0 of 16 |

So it is a runner defect, it needs a FAILING test with enough non-ASCII output,
and it is intermittent — which is exactly the situation of a mutation gate,
whose every run is meant to fail.

**What we do.** `scripts/mutants.ts` runs the red tests with
`--experimental-test-isolation=none`: no child process, no output parsing, and
`--test-timeout` still applies. It also made the gate faster (≈200 s → ≈140 s).
Control: a no-op mutant still SURVIVES under this mode, so the gate can still
say no. `npm test` keeps process isolation — its tests pass, so their output
carries no big diffs.

**If you hit it elsewhere.** Run in-process as above, or keep failure messages
ASCII. Replacing the em dash made the hang disappear, but any multi-byte text
(names, Cyrillic, emoji) in a large diff can trigger it.
