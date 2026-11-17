# ROFLENOX quickstart

ROFLENOX is a signed-log knowledge server. Every fact is part of a batch signed
by an identity, and the ROFL engine (`rofl serve`, from the npm package `@grafema/rofl`) is the index you query.
The only npm dependency is that engine. The CLI is `src/cli.ts`, run by Node's
built-in TypeScript stripping.

Every command below was run verbatim, in this order, from this directory,
against a fresh throwaway data directory. The outputs are real but abridged,
and long hashes are shortened with `…`. The only line you should change is
the `DEMO=` line in step 2.

## 1. Prerequisites

```sh
node --version
npm install
```
```
v22.22.0
added 2 packages …
```

- You need Node 22.6 or newer, because of `--experimental-strip-types`.
- The one dependency is the ROFL engine, `@grafema/rofl`, pinned to one
  version; npm installs this platform's engine binary beside it
  (`@grafema/rofl-<os>-<cpu>`). `ROFL_BIN` overrides it with another `rofl`
  binary, e.g. a build of Disentinel/rofl. If the engine is missing, `serve`
  fails straight away and says what to install. It does not hang.
- `./src/cli.ts` runs through its `#!/usr/bin/env -S node --experimental-strip-types …`
  line. `node --experimental-strip-types --no-warnings src/cli.ts …` works too.

## 2. Create an identity

```sh
DEMO=/tmp/roflenox-demo          # any throwaway directory
mkdir -p "$DEMO"
export ROFLENOX_DATA="$DEMO/data"
./src/cli.ts init --name node.example.org
ls -la "$ROFLENOX_DATA" "$ROFLENOX_DATA/key"
```
```
recovery code for node.example.org — shown once, stored nowhere; write it down:
  <RECOVERY-CODE>
identity node.example.org ready in /tmp/roflenox-demo/data

/tmp/roflenox-demo/data:
drwx------  key
/tmp/roflenox-demo/data/key:
-rw-------  identity.json
```

- The data directory is `--data DIR`, or the `ROFLENOX_DATA` environment
  variable, or `~/.roflenox` if neither is set. This guide sets
  `ROFLENOX_DATA` once, so no command needs `--data`.
- **The recovery code is printed once, on stderr, and stored nowhere.** Put it
  in a password manager now. It is the only way to run `recover`, which
  revokes every earlier key if the key file is lost or stolen. Never paste a
  real code into a README, a ticket or a chat.
- `init` is local. It **does not need a running node**, it does not read
  stdin, and it returns in about 0.2 s. You can also skip it: `serve` and
  `stdio` create an identity on first start if there is none. If you skip it,
  the name defaults to the hostname and the recovery code goes to that
  process's stderr, where it is easy to lose. Run `init` first.

## 3. Start the node, and stop it

```sh
./src/cli.ts serve &
SERVE_PID=$!
until ./src/cli.ts health >/dev/null 2>&1; do sleep 0.5; done
./src/cli.ts health
```
```
serving node.example.org at http://127.0.0.1:7380
{
  "identity": "node.example.org",
  "heads": {},
  "facts": 0,
  "batches": 0,
  "forks": 0,
  "engine": { "up": true, "restarts": 0 },
  "warnings": [],
  …
}
```

- `serve` listens on `127.0.0.1:7380` by default (`--port`, `--host`). The
  other commands find it at `--url`, or `ROFLENOX_URL`, or
  `http://127.0.0.1:7380` if neither is set.
- **To stop it:** `kill $SERVE_PID` (SIGTERM), or Ctrl-C if it runs in the
  foreground. Either one closes the HTTP server and the engine child cleanly.
  This guide stops the node in step 5, after the backup.

## 4. Write facts and read them back

A fact has five fields: `source`, `relation`, `target`, `perspective` and
`confidence`. You can write facts in two ways: `assert`, where the node signs
them as its own identity, or `publish`, where the CLI signs a JSONL file with
your local key and sends it in.

```sh
./src/cli.ts assert --facts '[{"source":"ada@example.org","relation":"works_on","target":"roflenox","perspective":"demo","confidence":0.9}]'
printf '%s\n' '{"source":"grace@example.org","relation":"reviews","target":"roflenox","perspective":"demo","confidence":0.8}' > "$DEMO/facts.jsonl"
./src/cli.ts publish "$DEMO/facts.jsonl"
./src/cli.ts ask 'edge(F, S, R, T)'
```
```
{ "admitted": true, "identity": "node.example.org", "facts": 1 }
published 1 facts as node.example.org
node.example.org	"2767b997…"	"ada@example.org"	"works_on"	"roflenox"
node.example.org	"81e10381…"	"grace@example.org"	"reviews"	"roflenox"
2 rows
```

`ask` takes one ROFL literal. `F` is the fact id, and each row shows the
values of the literal's variables. `why` explains why a ground literal holds,
and `whynot` explains why one does not:

```sh
F=$(./src/cli.ts ask 'edge(F, "ada@example.org", "works_on", T)' | head -1 | cut -f2 | tr -d '"')
./src/cli.ts why "edge(\"$F\", \"ada@example.org\", \"works_on\", \"roflenox\")"
./src/cli.ts whynot "edge(\"$F\", \"ada@example.org\", \"works_on\", \"grafema\")"
```
```
[node.example.org] edge[b_208768b5cdf6c6e4]("2767b997…","ada@example.org","works_on","roflenox") [axiom]
[node.example.org] whynot edge[b_208768b5cdf6c6e4]("2767b997…","ada@example.org","works_on","grafema"):
  no rule concludes 'edge' and no matching base fact exists
```

Now take a backup while the node is still running (step 8 covers backups),
then stop the node:

```sh
./src/cli.ts backup --to "$DEMO/backup"
kill $SERVE_PID
wait $SERVE_PID
```
```
backed up 2 receipts to /tmp/roflenox-demo/backup/latest
```

## 5. Connect an MCP client over stdio

`stdio` runs the node **inside the MCP client's process**, on the same data
directory, with no HTTP server. The caller is this machine's own identity,
so the local-only operations are offered as tools too.

> One process owns a data directory at a time. While `serve` runs on it,
> `stdio` on the same directory refuses to start and names the holder:
> `roflenox: the data directory … is held by serve (pid …, at http://127.0.0.1:7380); …`.
> Stop `serve` first, as step 4 does, or give each one its own data directory.
> A local operation that signs (`publish`, `seal`, `import_enox`, …) goes
> through a running `serve` when `--url` is that serve's: it hands the serve its
> facts, and the serve signs them, one batch at a time on its own head, so
> concurrent publishes never fork the chain. `rotate`, `recover` and
> `checkpoint` sign with the key themselves, so they refuse while a `serve`
> holds the directory: stop it first. Otherwise a local operation takes the
> directory itself for as long as it runs. A holder killed without letting go
> leaves a stale lock (`<data>/lock`), which the next process takes over.

This proves it works by speaking raw JSON-RPC to the server: `initialize`,
then `tools/list`, then one `tools/call`:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"query":"edge(F, S, \"reviews\", T)"}}}' \
  | ./src/cli.ts stdio > "$DEMO/mcp.out"
node -e 'for (const l of require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n")) { const m = JSON.parse(l); console.log(m.id, m.result.serverInfo?.name ?? (m.result.tools ? m.result.tools.length + " tools: " + m.result.tools.map((t) => t.name).join(", ") : m.result.content[0].text)); }' "$DEMO/mcp.out"
```
```
1 roflenox
2 47 tools: health, identity, identity_chain, ask, why, whynot, chain, feed, admit, assert, introduce, challenge, admit_feed, admit_sealed, init, publish, mirror, invite, rotate, recover, backup, checkpoint, seal, open, import_enox, follow, operator_token, query_graph, graph_stats, explore, traverse, recall, semantic_search, recent_activity, decide, add_assertion, batch_assertions, remember, …
3 {"vars":["F","S","T"],"rows":[{"identity":"node.example.org","cells":["81e10381…","grace@example.org","roflenox"]}]}
```

To register it with Claude Code as a project server, run this from the project
directory where you want it (`RFX` is this roflenox checkout):

```sh
RFX="$PWD"                        # run this line in the roflenox directory
(cd "$DEMO" && claude mcp add --scope project roflenox -e ROFLENOX_DATA="$ROFLENOX_DATA" -- node --experimental-strip-types --no-warnings "$RFX/src/cli.ts" stdio && cat .mcp.json)
```
```
Added stdio MCP server roflenox with command: node --experimental-strip-types --no-warnings /path/to/roflenox/src/cli.ts stdio to project config
{
  "mcpServers": {
    "roflenox": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "--no-warnings", "/path/to/roflenox/src/cli.ts", "stdio"],
      "env": { "ROFLENOX_DATA": "/tmp/roflenox-demo/data" }
    }
  }
}
```

That `.mcp.json` is the snippet to commit to a project, if you want to. It
holds a path and nothing secret. Claude Code asks you to approve a project
server the first time you run `claude` in that directory.
(`claude mcp get roflenox` shows `Pending approval` until you do.) If `ROFL_BIN`
is not at the default path, add `-e ROFL_BIN=…`.

## 6. The operator token

The operator token is a bearer token that stands for this node's own identity
over **HTTP MCP** (`POST /mcp` on a running `serve`). It is how a remote MCP
client acts as the operator, for example to call `assert`. It is a random
32-byte value stored in `$ROFLENOX_DATA/key/operator-token` (mode 0600).
The file is created the first time the token is asked for. `operator_token`
is a local-only operation: it prints the token only on the machine that holds
the data directory, and it is not offered over the network.

This was verified against a running `serve`, without the token ever reaching
the screen. With the token, `assert` works. Without it, `assert` is refused
as `not_operator`. With a wrong token, the request gets 401 `bad_token`:

```sh
./src/cli.ts operator_token > /dev/null
ls -l "$ROFLENOX_DATA/key/operator-token"
./src/cli.ts serve &
SERVE_PID=$!
until ./src/cli.ts health >/dev/null 2>&1; do sleep 0.5; done
curl -s http://127.0.0.1:7380/mcp -H 'content-type: application/json' -H "Authorization: Bearer $(./src/cli.ts operator_token)" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"assert","arguments":{"facts":[{"source":"ada@example.org","relation":"likes","target":"tea","perspective":"demo","confidence":0.5}]}}}'
curl -s http://127.0.0.1:7380/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"assert","arguments":{"facts":[{"source":"ada@example.org","relation":"likes","target":"coffee","perspective":"demo","confidence":0.5}]}}}'
curl -s http://127.0.0.1:7380/mcp -H 'content-type: application/json' -H 'Authorization: Bearer not-the-token' -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
kill $SERVE_PID
wait $SERVE_PID
```
```
-rw-------  43 …  /tmp/roflenox-demo/data/key/operator-token
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"admitted\":true,\"identity\":\"node.example.org\",\"facts\":1}"}]}}
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"error\":\"not_operator\",\"message\":\"assert is the node's own identity's to call\"}"}],"isError":true}}
{"error":"bad_token","message":"the bearer token is not this node's operator token"}
```

Wherever a client config needs the token, write the placeholder
`<OPERATOR_TOKEN>` in docs and fill it in only on the machine that uses it.
Never commit it.

## 7. Where the secrets live

| Secret | Where | Protection |
|---|---|---|
| Private key and identity chain | `$ROFLENOX_DATA/key/identity.json` | 0600, in a 0700 `key/` directory. `load` checks the mode. |
| Operator token | `$ROFLENOX_DATA/key/operator-token` | 0600. Created on first use. |
| Recovery code | Nowhere on disk. Printed once by `init` (or on first `serve`/`stdio`). | Your password manager. |

```sh
ls -la "$ROFLENOX_DATA/key"
```
```
drwx------  .
-rw-------  identity.json
-rw-------  operator-token
```

The data directory itself is created with mode 0700. `log/` inside it (the
signed batches) is 0755, but the 0700 parent protects it. Do not keep the data
directory inside a git checkout: nothing secret belongs in the repo, and
`key/` is exactly that.

## 8. Backup, and deleting the throwaway data

`backup --to DIR` copies the log up to its last receipt into a new snapshot
and points `DIR/latest` at it, **verified by a rebuild** through the engine. It
worked while `serve` was running (step 4). `serve --backup-to DIR --backup-every S`
does the same thing on a schedule.

```sh
ls "$DEMO/backup/latest" "$DEMO/backup/latest/log"
```
```
/tmp/roflenox-demo/backup/latest:
backup.json  log
/tmp/roflenox-demo/backup/latest/log:
b_208768b5cdf6c6e4  index.jsonl
```

The backup holds the **log only, not `key/`**. Back up the key file separately
(encrypted), or rely on the recovery code and `recover`.

Once no node is running on the data directory, delete the throwaway data:

```sh
rm -rf "$DEMO"
```

## 9. Subscribe to a question's conclusions, views, journals

A node (FKTS, for people; `roflenox` on the wire) keeps a question answered as
batches arrive. A **subscription** names one positive literal, e.g.
`red(P, X)` or `red("home", X)` or `red[b_…](P, X)`; it is sent the whole
answer once, then after every admitted batch only the rows that came and went.
The rows come from the engine's own delta (`rofl serve` `watch`, which the
pinned `@grafema/rofl` 1.5.0 does not have yet: set `ROFL_BIN` to a `rofl`
built from Disentinel/rofl with `watch`), never from asking again, so a frame
after a batch costs about the batch, not the relation (measured, `npm run perf`,
test/perf/subscribe.test.ts: a one-fact batch reaches the subscriber in
26–43 ms at 10, 10 000 and 100 000 rows, where asking whole takes 25 ms, 0.25 s
and 3.7 s). Access is exactly `ask`'s: a reader sees only the books it may read.

```sh
# a stream of server-sent events: `event: full|delta|refused`, `data:` a JSON frame
curl -N -H 'Accept: text/event-stream' -H "Authorization: Bearer $(./src/cli.ts operator_token)" \
  'http://127.0.0.1:7380/subscribe?query=red(P,%20X)'
# as a call (CLI, MCP tool `subscribe`, POST /op/subscribe): one frame, and the next within --wait seconds
./src/cli.ts subscribe 'red(P, X)' --wait 30
```

A frame is `{kind, head, cause, vars?, rows?, added?, removed?, by?}`:
`full` carries `rows` (as `ask` answers them), `delta` carries `added` and
`removed`; `cause` is the digest of the batch that moved them (or `start`,
`access`, `rebuilt`, `lost`, `clock`); `by` is how the engine took it (`delta`,
`whole`, `diff`, or `reask`). A `full` frame is sent again whenever the rows
cannot be carried over: the reader's access changed (a grant, an export, a
rule, a new book; a grant that expired, which the node's timer or `tick()`
notices), the rule world was rebuilt, or the engine was replaced. `refused`
ends a subscription to a book the reader may no longer read. Relations the
node answers itself (`live`, `conf`, `persp`, `asserted`, `admitted_at`,
`answered`) are asked again after each batch and diffed (`by: reask`).

**A view** is a fact in the owner's book; the node serves its page:

```sh
./src/cli.ts assert --facts '[{"source":"stale-pages","relation":"roflenox:view","target":"red(P, X)","perspective":"view","confidence":1}]'
open "http://127.0.0.1:7380/view/node.example.org/stale-pages#token=<OPERATOR_TOKEN>"
```

The page is static HTML+JS: it opens its own path as an event stream with the
token from `#token=` (kept in the page's memory only, or typed in) and lights
rows up as they come and dims them as they go. A literal with no book is the
owner's book. The same path answers `Accept: text/event-stream` (the stream)
and a plain call (the `view` op: one frame).

**A journal** is a fact in the node's own book; the node then signs, in its
own book, one fact per transition of the literal's rows:

```sh
./src/cli.ts assert --facts '[{"source":"reds","relation":"roflenox:journal","target":"red(P, X)","perspective":"journal","confidence":1}]'
./src/cli.ts ask 'edge(F, S, "roflenox:appeared", Batch)'     # and roflenox:vanished
```

Each is `{source: <the row, e.g. red[b_…]("home", "login@v1")>, relation:
"roflenox:appeared" | "roflenox:vanished", target: <the batch that moved it>,
perspective: "journal:<name>"}`, and `why` of one ends with `caused by batch
<digest> (admission n, <identity>'s batch s)`. When a journal starts (or its
rows had to be read whole), it compares the answer with what it last said of
each row, so nothing is said twice or missed across a restart.

## 10. Pods: each node holds only its files, a coordinator holds the question

A **pod** is a node of its own identity beside an engine that holds one
program (the JS model of `@grafema/rofl`, or any ROFL files) over **only its
files** of a corpus, plus the corpus's core (the facts a scan writes naming no
file: the listing, the strings). A **coordinator** is a plain node that
follows the pods' feeds and holds the cross-file rules and the question; a
subscriber on it (step 9) is sent each pod's edit as a delta. `src/federation.ts`.

```
  pod-0 (files A)                 pod-1 (files B)
  engine: program + core + A      engine: program + core + B
  watch(escapes) -> rows +/-      watch(escapes) -> rows +/-
  node pod-0: signed batches      node pod-1: signed batches
        \  roflenox:follow (pull)  /
         v                        v
   coordinator: decode rules (one per escape) + cross-file rules
   GET /subscribe?query=exports_name(F, Name, File)  -> full, then deltas
```

**What crosses** is decided by the coordinator's rules, not by a model's
names: every relation their bodies read, and the question's own relation
(`escapesOf`), narrowed by the constants a premise spells
(`ast_node(E, "export_all_declaration", File)` lets only those rows cross; a
premise with no constant, or under `not`, lets all of them). A row of `R` is
published as one fact per cell, `{source: <row id>, relation: "row:R#i",
target: <cell>}`; a row that goes is re-asserted at confidence 0. The
coordinator reads them back with one rule per escape (`decodeRules`), over
every book it follows (`follows(N, B)`), through each fact's current assertion.

Run it (needs `ROFL_BIN`, a `rofl` with `watch`; nothing to build):

```sh
export ROFL_BIN=/path/to/rofl            # Disentinel/rofl with watch
node --experimental-strip-types --no-warnings --test test/pods.test.ts      # the oracle, ~13 s
npm run mutants -- --only P1,P2,P3,P4                                         # its planted faults, all red
node --experimental-strip-types --no-warnings scripts/pods-cost.ts DIR 3 --interleave   # the cost on a corpus
```

The test and the cost script stand the federation up with
`test/pods-harness.ts` (`Federation.start(root, assign, pods)`): it scans the
corpus with the pinned `@grafema/rofl`'s `rofl scan`, cuts the facts by file
(`splitFacts`: a node id's prefix `n<16 hex>_` names its file), starts a node
and a `Pod` per pod, grants the coordinator its books, publishes on the
coordinator the rules (`RULES`: the JS model's three rules of `exports_name`
that read another file and the two `[surface]` mirrors they read, books
dropped; plus `decodeRules(ESCAPES)`) and a `roflenox:follow`
per pod, and subscribes. To do it by hand, the same calls in this order:
`Pod.start({program, escapes, publish}, core, files)` per pod (`publish` signs
the facts as the pod's identity into its node); on each pod a
`roflenox:grant` to the coordinator; on the coordinator one `roflenox:rule`
per rule and decode rule and one `roflenox:follow` per pod (target: its
invitation link), then `./src/cli.ts follow` (or `mirror`). An edit is
`pod.edit(file, factsNow | null, coreNow)`: the pod sends the difference as one
`edit` request (the facts out and in, by delta; `by: 'delta'`, or `'whole'` where
the engine refused the delta and evaluated the same world), evaluates its files
anew only where the engine refuses the edit or loses the watch (`by: 'anew'`),
and publishes only the rows that came and went.

**The oracle** (`test/pods.test.ts`): the corpus scanned anew and evaluated in
one engine answers the question; after the load, an edit that moves only its
own file's rows, an edit on pod 0 that moves what files of pod 1 offer (a
function renamed behind `export *`) and a deletion, the subscriber's rows equal
it, row for row; the rename is asserted to go by delta, and a fourth step (a
fact taken out of the pod's world behind it, so the engine refuses the edit)
goes anew. The planted faults `P1` (a pod never retires a row), `P2` (an
escape omitted), `P3` (constants misread), `P4` (anew forgets what went) turn it red.

**`why` on the coordinator** reaches the pod's signed batch: the row's facts,
their batch digest, admission and the pod's batch number, and the grant it
reads by. Below that is the pod's own proof, which `pod.why(L)` answers in
the pod's engine (down to the scanner's facts); the two are not stitched.

**Measured** (vscode `src/vs/base/common`, 155 files, no tests; 3 pods by
`--interleave`; the `fast` profile of rofl with watch; a shared laptop):

| | whole world, one engine | pods (each) | coordinator |
|---|---|---|---|
| evaluation | 26.1 s | 4.3 – 6.8 s (52 files) | — |
| engine memory | 2 208 MB | 551 – 736 MB (+17 MB its node) | 33 – 60 MB |
| what it holds | 8.4 M facts | 628 – 830 rows published (1 767 – 2 404 facts) | the pods' 2 115 rows (5 989 facts) |
| one file edited (an export added) | — | 215 ms by delta | frame 551 ms after the edit |
| one function renamed behind `export *` | — | 6.8 s anew; by `edit` 478 ms (323 facts out, 323 in; anew on the same run 5.9 s) | frame 7.2 s; by `edit` 852 ms (anew 6.3 s) |

The answer (903 rows) equals the whole world's. On `observableInternal` (39
files, 2 pods) with the follow executor at 50 ms: frames 284 ms (an export
added) and 1.3 s (a rename, the pod anew).

**What does not scale yet:** (an edit that takes facts out cost the pod's
whole evaluation while the engine retracted one fact per request, 343 ms a
fact; since `edit` it costs the facts that moved: on observableInternal, 2
pods of 19 and 18 files, the rename 842 ms anew against 93 ms by `edit`.) Every pod holds the whole corpus's core; the cut (which
rules are the coordinator's) is given, not derived, and a model rule that
crosses files through another relation (here `may_be_node`, behind
`export { x }` of an imported `x`) must be among the coordinator's rules or the
oracle goes red; a cell's type is lost on the wire (an atom and a string
arrive as one text, an integer as its digits).

## Known defects (found while writing this guide)

1. Fixed: running `stdio` beside `serve` on one data directory used to fork the
   node's own chain. The data directory is now locked (see step 5), and the
   second process refuses before it reads or writes anything.
