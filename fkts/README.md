# FKTS quickstart

FKTS (Federated Knowledge Tracking Server) is the implementation of the Enox
protocol on the ROFL engine; it was called Roflenox until 2026-11-17. It is a
signed-log knowledge server. Every fact is part of a batch signed
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
DEMO=/tmp/fkts-demo          # any throwaway directory
mkdir -p "$DEMO"
export FKTS_DATA="$DEMO/data"
./src/cli.ts init --name node.example.org
ls -la "$FKTS_DATA" "$FKTS_DATA/key"
```
```
recovery code for node.example.org — shown once, stored nowhere; write it down:
  <RECOVERY-CODE>
identity node.example.org ready in /tmp/fkts-demo/data

/tmp/fkts-demo/data:
drwx------  key
/tmp/fkts-demo/data/key:
-rw-------  identity.json
```

- The data directory is `--data DIR`, or the `FKTS_DATA` environment
  variable, or `~/.fkts` if neither is set. This guide sets
  `FKTS_DATA` once, so no command needs `--data`.
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
  other commands find it at `--url`, or `FKTS_URL`, or
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
./src/cli.ts assert --facts '[{"source":"ada@example.org","relation":"works_on","target":"fkts","perspective":"demo","confidence":0.9}]'
printf '%s\n' '{"source":"grace@example.org","relation":"reviews","target":"fkts","perspective":"demo","confidence":0.8}' > "$DEMO/facts.jsonl"
./src/cli.ts publish "$DEMO/facts.jsonl"
./src/cli.ts ask 'edge(F, S, R, T)'
```
```
{ "admitted": true, "identity": "node.example.org", "facts": 1 }
published 1 facts as node.example.org
node.example.org	"2767b997…"	"ada@example.org"	"works_on"	"fkts"
node.example.org	"81e10381…"	"grace@example.org"	"reviews"	"fkts"
2 rows
```

`ask` takes one ROFL literal. `F` is the fact id, and each row shows the
values of the literal's variables. `why` explains why a ground literal holds,
and `whynot` explains why one does not:

```sh
F=$(./src/cli.ts ask 'edge(F, "ada@example.org", "works_on", T)' | head -1 | cut -f2 | tr -d '"')
./src/cli.ts why "edge(\"$F\", \"ada@example.org\", \"works_on\", \"fkts\")"
./src/cli.ts whynot "edge(\"$F\", \"ada@example.org\", \"works_on\", \"grafema\")"
```
```
[node.example.org] edge[b_208768b5cdf6c6e4]("2767b997…","ada@example.org","works_on","fkts") [axiom]
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
backed up 2 receipts to /tmp/fkts-demo/backup/latest
```

## 5. Connect an MCP client over stdio

`stdio` runs the node **inside the MCP client's process**, on the same data
directory, with no HTTP server. The caller is this machine's own identity,
so the local-only operations are offered as tools too.

> One process owns a data directory at a time. While `serve` runs on it,
> `stdio` on the same directory refuses to start and names the holder:
> `fkts: the data directory … is held by serve (pid …, at http://127.0.0.1:7380); …`.
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
1 fkts
2 47 tools: health, identity, identity_chain, ask, why, whynot, chain, feed, admit, assert, introduce, challenge, admit_feed, admit_sealed, init, publish, mirror, invite, rotate, recover, backup, checkpoint, seal, open, import_enox, follow, operator_token, query_graph, graph_stats, explore, traverse, recall, semantic_search, recent_activity, decide, add_assertion, batch_assertions, remember, …
3 {"vars":["F","S","T"],"rows":[{"identity":"node.example.org","cells":["81e10381…","grace@example.org","fkts"]}]}
```

To register it with Claude Code as a project server, run this from the project
directory where you want it (`RFX` is this fkts checkout):

```sh
RFX="$PWD"                        # run this line in the fkts directory
(cd "$DEMO" && claude mcp add --scope project fkts -e FKTS_DATA="$FKTS_DATA" -- node --experimental-strip-types --no-warnings "$RFX/src/cli.ts" stdio && cat .mcp.json)
```
```
Added stdio MCP server fkts with command: node --experimental-strip-types --no-warnings /path/to/fkts/src/cli.ts stdio to project config
{
  "mcpServers": {
    "fkts": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-strip-types", "--no-warnings", "/path/to/fkts/src/cli.ts", "stdio"],
      "env": { "FKTS_DATA": "/tmp/fkts-demo/data" }
    }
  }
}
```

That `.mcp.json` is the snippet to commit to a project, if you want to. It
holds a path and nothing secret. Claude Code asks you to approve a project
server the first time you run `claude` in that directory.
(`claude mcp get fkts` shows `Pending approval` until you do.) If `ROFL_BIN`
is not at the default path, add `-e ROFL_BIN=…`.

## 6. The operator token

The operator token is a bearer token that stands for this node's own identity
over **HTTP MCP** (`POST /mcp` on a running `serve`). It is how a remote MCP
client acts as the operator, for example to call `assert`. It is a random
32-byte value stored in `$FKTS_DATA/key/operator-token` (mode 0600).
The file is created the first time the token is asked for. `operator_token`
is a local-only operation: it prints the token only on the machine that holds
the data directory, and it is not offered over the network.

This was verified against a running `serve`, without the token ever reaching
the screen. With the token, `assert` works. Without it, `assert` is refused
as `not_operator`. With a wrong token, the request gets 401 `bad_token`:

```sh
./src/cli.ts operator_token > /dev/null
ls -l "$FKTS_DATA/key/operator-token"
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
-rw-------  43 …  /tmp/fkts-demo/data/key/operator-token
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
| Private key and identity chain | `$FKTS_DATA/key/identity.json` | 0600, in a 0700 `key/` directory. `load` checks the mode. |
| Operator token | `$FKTS_DATA/key/operator-token` | 0600. Created on first use. |
| Recovery code | Nowhere on disk. Printed once by `init` (or on first `serve`/`stdio`). | Your password manager. |

```sh
ls -la "$FKTS_DATA/key"
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
/tmp/fkts-demo/backup/latest:
backup.json  log
/tmp/fkts-demo/backup/latest/log:
b_208768b5cdf6c6e4  index.jsonl
```

The backup holds the **log only, not `key/`**. Back up the key file separately
(encrypted), or rely on the recovery code and `recover`.

Once no node is running on the data directory, delete the throwaway data:

```sh
rm -rf "$DEMO"
```

## 9. Subscribe to a question's conclusions, views, journals

A node keeps a question answered as
batches arrive. A **subscription** names one positive literal, e.g.
`red(P, X)` or `red("home", X)` or `red[b_…](P, X)`; it is sent the whole
answer once, then after every admitted batch only the rows that came and went.
The rows come from the engine's own delta (`rofl serve` `watch`, in
`@grafema/rofl` since 1.8.0), never from asking again, so a frame
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

A frame is `{kind, head, cause, vars?, rows?, added?, removed?, by?, why?}`:
`full` carries `rows` (as `ask` answers them), `delta` carries `added` and
`removed`; `cause` is the digest of the batch that moved them (or `start`,
`access`, `rebuilt`, `lost`, `clock`); `by` is how the engine took it (`delta`,
`whole`, `diff`, or `reask`).

**A batch that moves rules or access goes by delta too.** A rule added is
loaded into the author's kept rule world by delta; a rule retired (re-asserted
at confidence 0), no longer trusted, or out of its session's delegation has
its guard fact (`rule_on[sys_fkts]`, one per rule) taken out by delta, and
switched on again put back; a grant, export, delegation, trust or follow goes
in and out of the world as its rows; a book a rule now names or ranges over is
loaded into the world; the clock (a grant's expiry) moves by one `edit`, and
the node's timer also wakes at the expiry of a grant a kept rule world reads
by. The admission trial of the owner's rules is a fork of the kept world
taking the batch by delta. So a subscriber whose own access did not change is
sent a `delta` with `by: delta` (measured, `npm run perf`,
test/perf/subscribe-rules.test.ts: a rule added, retired or switched on again
over a red(P, X) of 10 / 10 000 / 100 000 rows reaches the subscriber in
41–55 ms / 46–77 ms / 0.13–0.51 s as a one-row delta, where it was a full frame
in 75–88 ms / 0.40–0.43 s / 4.3–4.4 s; a grant to another reader is admitted
in 44 ms at 100 000 rows, where it was 2.5 s). An author's first rules make a
world where there was none: its rows are sent as `added`, `by: whole`.

A `full` frame is sent again only when the rows cannot be carried over: the
reader's own access changed (a grant to it, an export to it, a book of its
own; a grant to it that expired), the rule world had to be built anew — it fell
behind the log, ran out of its budget, or the engine refused what it was sent
— and then the frame says `by: whole` and `why`, or the engine was replaced.
`refused` ends a subscription to a book the reader may no longer read.
Relations the node answers itself (`live`, `conf`, `persp`, `asserted`,
`admitted_at`, `answered`) are asked again after each batch and diffed (`by:
reask`).

**A view** is a fact in the owner's book; the node serves its page:

```sh
./src/cli.ts assert --facts '[{"source":"stale-pages","relation":"fkts:view","target":"red(P, X)","perspective":"view","confidence":1}]'
open "http://127.0.0.1:7380/view/node.example.org/stale-pages#token=<OPERATOR_TOKEN>"
```

The page is static HTML+JS: it opens the stream of `/view/<owner>/<name>` on
its own origin (a prefix of path segments a reverse proxy adds is kept) with
the token from `#token=` (kept in the page's memory only, or typed in) and
lights rows up as they come and dims them as they go. It is served with a
Content-Security-Policy that runs only its own script and style, connects
only to its own origin (`connect-src 'self'`) and lets nobody frame it
(`frame-ancestors 'none'`, `X-Frame-Options: DENY`). The node refuses (400
`bad_path`) any request path a URL parser would read as another: a leading
`//` or `/\` (a host), a `.` or `..` segment, plain or percent-encoded — so a
reverse proxy must pass paths through as the browser sent them. A literal
with no book is the owner's book. The same path answers `Accept:
text/event-stream` (the stream) and a plain call (the `view` op: one frame).

**A view for a grantee, in a browser: a view link.** Any identity whose key
is valid here mints a link with its own key, on its own machine, for one view
on one node, for the view's definition as it is now, for at most a day
(default an hour). The operator may mint one too (then the view is read with
the operator's access, read-only, for that view, until the link ends):
prefer it to handing out the operator token, which never expires and writes.

```sh
./src/cli.ts view_link node.example.org stale-pages --url https://node.example.org --ttl 3600 --data ~/.fkts-eve
# https://node.example.org/view/node.example.org/stale-pages#link=<claims>.<signature>
# (for node.example.org's view red[b_…](P, X); expires …; revoke: jti …)
```

The node the link is for (`aud`) is taken from the node's own unauthenticated
`health` only over HTTPS or on this machine (no `--url`, or a loopback one);
over plain HTTP to another machine `--aud <the node's identity>` is required,
and wherever `--aud` is given the node must say the same (409
`wrong_audience`). The link signs a hash of the view's literal (`lit`), read
as its issuer when it is minted.

The page sends it as `Authorization: FKTSView <link>` on the stream of
that path, and the node reads the view as the link's issuer, with exactly
`ask`'s access for it (src/viewlink.ts). The link is in the fragment, which a
browser never sends: it is in no request line, no proxy log, no `Referer`
(the page also says `no-referrer`), and the page drops it from the address
bar on load. It is refused (401 `bad_view_link`) for another view, another
node, any other route or a plain call, after its `exp`, with a claim or the
signature changed or spelt otherwise (base64url has one spelling), once its
key is no longer valid here (rotated, recovered, revoked), or once the view
is defined otherwise than when it was signed. An open stream of the link
ends (`refused`) with the reason: `link_revoked` when its issuer asserts
`{source: <jti>, relation: "fkts:revoke_link", target: "revoked"}` in its
own book, `link_key_invalid` when its key stops being valid, `view_redefined`
when the owner changes or retracts the view, `link_expired` at `exp`, and
`no_grant` when the owner withdraws the grant or export, as for any reader. A
revoke, a key change or a redefinition is admitted in a serial slot of its
own, before an open (which is then refused) or after it (the stream is then
ended), never between the open's checks and its stream. A link holds at most
4 open streams, and a reader at most 32 subscriptions here (all anonymous
readers together count as one); beyond that a subscription is refused (429
`too_many_streams`). A link whose signature does not verify is refused
before it waits on the node's queue. Until it expires or is revoked, whoever
holds the link reads that view as its issuer: share it as you would a
password, for as short as you can.

A key signs for one identity only: an identity document listing a key that
another identity's document already lists is refused (409 `key_taken`; a
stranger sees `not_vouched`), so one identity cannot make another's
signatures, requests or view links read as its own.

**A journal** is a fact in the node's own book; the node then signs, in its
own book, one fact per transition of the literal's rows:

```sh
./src/cli.ts assert --facts '[{"source":"reds","relation":"fkts:journal","target":"red(P, X)","perspective":"journal","confidence":1}]'
./src/cli.ts ask 'edge(F, S, "fkts:appeared", Batch)'     # and fkts:vanished
```

Each is `{source: <the row, e.g. red[b_…]("home", "login@v1")>, relation:
"fkts:appeared" | "fkts:vanished", target: <the batch that moved it>,
perspective: "journal:<name>"}`, and `why` of one ends with `caused by batch
<digest> (admission n, <identity>'s batch s)`. When a journal starts (or its
rows had to be read whole), it compares the answer with what it last said of
each row, so nothing is said twice or missed across a restart.

## 10. Pods: each node holds only its files, a coordinator holds the question

A **pod** is a node of its own identity beside an engine that holds one
program (the JS model of `@grafema/rofl`, or any ROFL files) over **only its
files** of a corpus, plus the part of the corpus's core (the facts a scan
writes naming no file: the listing, the strings) that its files reach by the
program's keys (below, *The core, routed*). A **coordinator** is a plain node that
follows the pods' feeds and holds the cross-file rules and the question; a
subscriber on it (step 9) is sent each pod's edit as a delta. `src/federation.ts`.

```
  pod-0 (files A)                 pod-1 (files B)
  engine: program + core(A) + A   engine: program + core(B) + B
  watch(escapes) -> rows +/-      watch(escapes) -> rows +/-
  node pod-0: signed batches      node pod-1: signed batches
        \  fkts:follow (pull)  /
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

Run it (on `@grafema/rofl` 1.8.0 these tests are red: they read the package's 1.5 layout and the scan as
text; pods as processes of the engine's levels, enox #6, replace them):

```sh
node --experimental-strip-types --no-warnings --test test/pods.test.ts      # the oracle, ~13 s
npm run mutants -- --only P1,P2,P3,P4,P5,P6,P7,P8,P9,P10                     # its planted faults, all red
```

The mutant gate cuts its shards by what each mutant cost when it last ran
(kept in `node_modules/.cache/fkts-mutants/costs.json`; a fresh clone
estimates a pods mutant at ~25 s; at most twice as many shards as cores): a
pods mutant stands up a federation and a red oracle waits out its 15 s, so the
ten are dealt out over the shards (cold 4 of 62 – 95 s, then 3 of 85 – 89 s,
measured 2026-11-18, ~40 s of each its baseline) and a shard over 120 s fails
the gate.

```sh
node --experimental-strip-types --no-warnings scripts/pods-cost.ts DIR 3 --interleave   # the cost on a corpus
```

The test and the cost script stand the federation up with
`test/pods-harness.ts` (`Federation.start(root, assign, pods)`): it scans the
corpus with the pinned `@grafema/rofl`'s `rofl scan`, cuts the facts by file
(`splitFacts`: a node id's prefix `n<16 hex>_` names its file), starts a node
and a `Pod` per pod, grants the coordinator its books, publishes on the
coordinator the rules (`RULES`: the JS model's three rules of `exports_name`
that read another file and the two `[surface]` mirrors they read, books
dropped; plus `decodeRules(ESCAPES)`) and a `fkts:follow`
per pod, and subscribes. To do it by hand, the same calls in this order:
`Pod.start({program, escapes, publish}, core, files)` per pod (`publish` signs
the facts as the pod's identity into its node); on each pod a
`fkts:grant` to the coordinator; on the coordinator one `fkts:rule`
per rule and decode rule and one `fkts:follow` per pod (target: its
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

**The core, routed** (`coreDemand`, `CoreRouter` in `src/federation.ts`). Which
core facts a pod holds is decided by the program's rules, not by relation
names, the way the engine's volumes lay a fact where a rule joins it
(`f_volumes_cross_by_the_rules_keys` in Disentinel/rofl): the escapes are
demanded whole; a rule's head demand flows to its premises in a sideways order
(a premise over an anchored relation first, one whose every derivation reads a
file's fact; then the ones already bound), and a premise is keyed at the
positions that the head's demand, a constant or an earlier premise binds to a
*stored* value (a position no `is` or compound writes, the greatest fixpoint).
Each keyed position carries where its values come from: the places of base
relations that bind it (through the derived relations between, resolved) and
the program's constants. A core fact is laid in a pod when one key of its
relation holds, at each keyed position, a value that the pod's world holds at
one of *that position's* sources (its files' facts and the core facts laid so
far, to a fixpoint), so a value bound at one key does not open another. A
premise whose other places are all `_` only asks whether some fact holds the
keyed values; for it one fact of each such tuple (a witness, the least) is
laid. It is magic sets with each magic relation widened to the values its
sources hold, so every core fact a derivation of an escape reads is laid; the
oracle holds it to the whole world. For the JS model it reads `str_*` by the
string, `fs_dir_of` by the file a site or node names, `fs_parent` and
`fs_file_in` by a directory a walk reaches, `fs_dir_in` by such a directory and
a segment, and `fs_file_in` by name only for `last_ext` (a witness: the pod's
own file of that name). Engine-free, `test/core-router.test.ts` holds it on a
corpus where a string `"z.ts"` and the name `index.ts` must not open `other/`;
planted faults P8 (one set of values for every key), P9 (no witness) and P10
(a derived relation's sources dropped, which the engine oracles also see). A program with a construct the analysis does not
model (a lattice, a dominance rule, a `want`) gives every pod the whole core.

The harness scans each file alone (as `rofl scan DIR FILE` does; the union of
the shares is held against the whole scan at start) and counts, for each core
fact, the files whose share holds it: an edit changes the file's share, a fact
no file holds any more leaves the corpus, and the router re-routes only the
pods whose files moved, that held a fact that left, or whose values reach a
fact that came; each of them gets one `edit` of its core by delta.

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

**The core routed, measured** (`scripts/pods-cost.ts DIR N [--whole-core]`,
the flag the control: every pod the whole core; `scripts/core-scale.ts ROOT N
PREFIX...` routes without an engine; release semantics `fast`, shared laptop):

| | core facts per pod, whole → routed | pod engine MB, whole → routed | pods a new string reaches | pods a new file reaches |
|---|---|---|---|---|
| observableInternal, 37 files, 2 pods | 1 062 → 742 / 525 | 182 / 189 → 192 / 197 | 2 → 1 | 2 → 2 |
| base/common, 153 files, 3 pods | 17 302 → 5 265 / 6 777 / 7 535 | 452 / 682 / 641 → 458 / 674 / 699 | 3 → 1 | 3 → 3 |
| vs/base, 304 files, 4 pods (router only) | 30 881 → 8 025 – 10 961 | | → 1 | |
| base+platform, 1 067 files, 8 pods | 100 615 → 14 303 – 21 458 | | → 1 | |
| base+platform+editor, 1 727 files, 13 pods | 151 363 → 12 282 – 22 349 | | → 1 | |

**Keyed per position** (2026-11-18; the same corpora, the router of the
commit before as the control, run beside it; "listing" the `fs_*` facts,
"files" the share of the corpus's `fs_file_in`, one fact a file):

| | core facts per pod, one set → per key | listing per pod | files listed per pod | route ms, all pods |
|---|---|---|---|---|
| vs/base, 304 files, 4 pods | 8 029 – 10 964 → 7 595 – 10 575 | 42 – 53% → 24 – 32% | 70 – 83% → 55 – 71% | 50 → 124 |
| base+platform, 1 067 files, 8 pods | 14 307 – 21 462 → 12 842 – 20 208 | 30 – 52% → 9 – 30% | 49 – 80% → 20 – 65% | 207 → 654 |
| base+platform+editor, 1 727 files, 13 pods | 12 286 – 22 353 → 10 328 – 20 565 | 30 – 49% → 5 – 29% | 51 – 76% → 12 – 66% | 339 → 1 619 |
| base/common, 153 files, 3 pods (pods-cost) | 8 218 / 6 113 / 4 938 → 8 090 / 5 918 / 4 746 | | | |

On base/common the pods' engines are 693 / 545 / 597 MB before and 701 / 549 /
583 MB after (noise), the oracle equal at the end of both runs (891 rows); a
new string reaches 1 pod, a new file all 3 (one directory).

**Keyed through the builtins** (2026-11-18): `file_stem` finds a file by its
stem, its name less the last extension, cut with `str_sub`, and the router
keyed the listing by the directory alone, so a pod held the whole listing of
every directory its imports walk into. The router now runs a rule's builtins
FORWARD, with the engine's own (`evalStrOp`, `evalArith` of the pinned
package): on a listing fact's name it computes the stem, on a pod's import
segment the stem the import asks for (`./a.js` asks `a`), and lays a name only
where the two meet. The program's own tables (`index_file`) are read before
the listing they key, so `index.ts` keys by name, not by directory. Same
corpus, same machine, the commit before as the control:

| | core facts per pod | listing per pod | files listed per pod | route ms, all pods |
|---|---|---|---|---|
| base+platform+editor, 1 727 files, 13 pods | 10 328 – 20 565 → 10 136 – 20 092 | 5 – 29% → 5 – 20% | 12 – 66% → 9 – 29% | 1 579 → 1 586 |
| base/common, 153 files, 3 pods (pods-cost) | 8 090 / 5 918 / 4 746 (the run before) → 8 056 / 5 859 / 4 695 | | | |

A hand count of the files each pod's relative imports name, and its own files,
is 9 – 24% at 1 727 files: what is left above it is the widening of the keys
(a directory and a stem held separately, not as a pair), not the listing of a
directory. On base/common every edit of pods-cost (a string, a new file
beside, a rename) touches 1 pod of 3, the new file too (all 3 before: every
pod walking the directory was given its listing), and the oracle is equal at
the end. The
stem is the only position of the JS model the router could not key and now
does: a sweep of every premise over a core relation with a builtin-written
variable bound beside it found no other.

The oracle equal at the end of every run. At these sizes the core is under 1%
of what a pod's engine holds and the pod's memory does not move (within the
noise); the program alone with 148 457 core facts (1 724 files) takes 241 MB
against 111 MB with one 133-file pod's share of 17 083 (84 MB the program alone),
about 1.06 KB a core fact. At 11 100 files the core is about 88 facts a file,
~975 000 facts and ~1 GB in every pod before; routed, a pod holds its files'
strings (~110 facts a file of the pod) and the part of the listing its walks
and the names reach (75% of it at 1 067 files, 64% at 1 727: ~15 000 facts at
11 100): ~170 000 facts (~180 MB) with 8 pods, ~55 000 (~60 MB) with 32.
What still grows with the corpus: the router, which holds the whole core once
beside the scanner, and computes the stem once for each distinct segment a pod
holds (40 803 at 1 727 files, ~0.2 s, kept for the next route).

**The router's index** (2026-11-18). Keyed per position, the router routed 4.7
times slower than with one set of values (1.6 s for 13 pods at 1 727 files,
against 0.35 s): a key's constant (`str_seg(S, 0, _)`, the first segment) was
indexed like a value, and every pod's route began by visiting every fact of the
corpus holding it: the 13 routes considered 920 000 facts, 766 000 of them
str_seg; now 310 000 in all. A
fact is now indexed only at the positions its key's constants do not hold, by
the position's group and the value, and a value's groups are bits of one number,
not an entry in a set per group. The work of a pod's route is now in the core
its files reach, not in the corpus. The shares are the same, pod for pod
(`scripts/core-scale.ts`, every pod's share hashed against the commit before);
a router with no index (test/core-router.test.ts) is the oracle. Medians of
three runs, alternated, the commit before per key (9894aa1) as the control:

| 1 727 files, 13 pods | one set of values | per key, before | per key, now |
|---|---|---|---|
| route ms, all pods, first | 355 | 1 719 | 587 |
| route ms, all pods again | 282 | 1 340 | 355 |
| a new string in pod 0, routed ms | 22 | 102 | 26 |
| a file of pod 0 out and back, ms | 56 | 231 | 68 |

The first route is 1.65 times the one set's: of it, ~190 ms are the stems
computed for the first time (the builtins run forward, ~40 000 segments), kept
for every later route.

**What does not scale yet:** (an edit that takes facts out cost the pod's
whole evaluation while the engine retracted one fact per request, 343 ms a
fact; since `edit` it costs the facts that moved: on observableInternal, 2
pods of 19 and 18 files, the rename 842 ms anew against 93 ms by `edit`.) The cut (which
rules are the coordinator's) is given, not derived, and a model rule that
crosses files through another relation (here `may_be_node`, behind
`export { x }` of an imported `x`) must be among the coordinator's rules or the
oracle goes red; a cell's type is lost on the wire (an atom and a string
arrive as one text, an integer as its digits).

**The whole of vscode** (2026-11-19; `scripts/pods-big.ts ROOT PER [--at-once K]
[--oracle] [--rule-budget N] [--out F.json]`; vscode at eef761e9, `src` without
tests, 7 234 files; the engine of rofl `main`, release; 4 cores, 15 GB).

| | 145 pods of 50, 2 at once | 97 pods of 75, 1 at once |
|---|---|---|
| answer rows of `exports_name` | 8 893 | 8 906 |
| all pods joined | 612 s | 966 s |
| a pod's engine, median / max | 4.7 s, 435 MB / 11.4 s, 805 MB | |
| core facts per pod, of 671 845 | median 9 200 (628 – 24 844) | |
| the coordinator's engine at its peak | 1 819 MB | 2 143 MB |
| one file edited: the pod's delta / the frame at the subscriber | 76 ms / 1 485 ms | / 1 857 ms |

Scanning twice took 228 s and the route 5 s. What it showed:

- **The answer depends on the cut.** The 13 rows the second cut has more are
  all `export const X = createDecorator(...)`: a value returned by a function
  of another file is resolved only when both files are in one pod, the
  coordinator's rules do not carry it. vscode has about 690 such exports (by
  text), and how many of them a cut catches is its luck. Against one engine on `vs/base` with tests
  (493 files, 10 pods) 1 305 rows of 1 306, the lost one of the same kind
  (`sampleCount`); one engine there took 91 – 97 s and 5.7 GB.
- **The default rule budget** (50 000 steps) is spent at about the 82nd pod
  (some 5 200 rows): the answer is then empty and every batch costs 9 – 21 s.
  The runs above set `--rule-budget 1000000000`.
- **The router** holds every file's facts in one process: about 7 GB, 1 MB a
  file.
- **The coordinator grows with the corpus**: a pod's `fkts:follow` cost 18 ms
  at the first pod and about 1.5 s at the last, its pull 131 ms and 2 – 3.3 s
  (a follow fact has the rule world built anew).
- Two pods stopped at the memory wall beside a neighbour and passed alone; a
  pod whose world stops no longer leaves its engine running (`Pod.start`).

## 11. Moving a node written before the rename

A data directory written as Roflenox (signatures `roflenox-*-v1`, relations
`roflenox:*`) does not open under FKTS. Copy it into a fresh directory, every
batch signed again by the key that signed it:

```sh
npm run migrate:roflenox -- ~/.roflenox ~/.fkts [--also OLD_EXECUTOR_DIR=NEW_EXECUTOR_DIR]...
```

The old directory is only read (the old node may keep running); the new one
must not exist and is opened as a node before the command succeeds. Sessions
get new names, derived from the same grants. `--also` is each other identity
whose key signed batches there (the embedder executor). A batch that cannot be
signed again (another node's identity mirrored in, a rotated key) refuses the
whole migration and is named. See `scripts/migrate.ts`.

## Known defects (found while writing this guide)

1. Fixed: running `stdio` beside `serve` on one data directory used to fork the
   node's own chain. The data directory is now locked (see step 5), and the
   second process refuses before it reads or writes anything.
