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

## 10. Questions over a directory of code, kept answered as it changes

`fkts code` keeps the node's questions over the JS/TS code of a directory
answered: the directory is scanned, the JS model and your own rules evaluated
by the engine's levels, and each question's rows published as the node's own
facts, so a view (section 9) shows them and a subscriber is sent what moved. A
file written or removed under the directory is scanned alone and settled again
where it moved the world: the units it touched, not the world (`by: levels`);
a file that comes, or one that moves the corpus's core (its listing, its
strings), stands the engine up anew (`by: anew`). `src/code.ts`.

```sh
./src/cli.ts serve &                                   # the node (section 3)
printf 'api(Name) :- exports_name[code](F, Name, "lib/b.ts").\n' > mine.rofl
./src/cli.ts code ~/work/app --rules mine.rofl --ask 'api(Name)' --ask 'exports_name(F, Name, File)'
./src/cli.ts assert --facts '[{"source":"api","relation":"fkts:view","target":"api(Name)","perspective":"view","confidence":1}]'
```
```
3 files of ~/work/app answered in 4.3 s: api(Name): +3 -0 (anew); exports_name(F, Name, File): +5 -0 (anew)
lib/a.ts: api(Name): +1 -1 (levels); exports_name(F, Name, File): +2 -2 (levels) in 0.2 s
```

- The engine needs `rofl serve` `volumes` (@grafema/rofl 1.8.1 or later, or
  `ROFL_BIN` set to a `rofl` built in a Disentinel/rofl tree at main since
  Disentinel/rofl#299, which brought them). The JS model and
  the scanner are always those of the engine's own source, the package or the
  tree it was built in, so the model matches the engine.
- The JS model's relations are in the book `code`: a rule of yours reads them
  as `exports_name[code](F, Name, File)`; an unbooked premise reads your own
  rules' conclusions.
- Each question is one literal, one per relation; only the rules the
  questions need run (`asks`, Disentinel/rofl docs/demand-cones.md).
- One engine process. `--pods N` splits the corpus over N engine processes
  (section 11); that is no way to speed, it exists for the federation's checks.

## 11. Pods: each pod settles only its files, a coordinator holds the question

A **pod** is a process of the engine's world by levels (`rofl serve` with
`ROFL_FAR`, Disentinel/rofl docs/cli.md, *The nodes as processes*): every
process runs the same levels over the same corpus and settles only the units
of its block of files (whole leaves of four files); the units it reads of
another pod it asks for over a unix socket, or TCP where `DIR/peers` says where
each listens. The **root** is the coordinator's engine: it settles the units
over more than one pod and answers the question. What crosses between pods is
decided by the engine from the rules' keys: no relation is named here and no
rule copied. `src/federation.ts`.

```
  pod-0 (files A)                pod-1 (files B)
  rofl serve, ROFL_FAR_ME=0      rofl serve, ROFL_FAR_ME=1
  settles the units of A         settles the units of B
          \   units, asked by relation, key, tree, firing   /
           v                                               v
      root (the coordinator's engine): the units over A and B, the question
      coordinator node: the answers as its own signed facts
      GET /subscribe?query=exports_name(F, Name, File)  -> full, then deltas
```

**An edit** goes to the root (`EngineNode.edit`, the engine's `volumes_edit`),
which sends it to every pod; each settles again only its units the edit moved,
and what they moved crosses as facts. An edit the levels cannot take (a file
that comes, or the core of the corpus moving: the listing, the strings) stands
the engines up anew over the corpus as it is now (`by: 'anew'`; else
`'levels'`).

**What is signed** is the coordinator's answers (owner, 2026-11-22): after each
step the root's rows that came are published as the coordinator's facts and
those that went re-asserted at confidence 0 (`Answers`); one rule
(`decodeRule`) reads them back as the question's relation. The units cross
between the pods of one owner unsigned. `why` on the coordinator reaches its
signed batch; the root's `why` goes down into the pods' units.

Run it (needs `ROFL_BIN`, a `rofl` with `volumes` built in its Disentinel/rofl
tree: `rust/target/<profile>/rofl`, the JS model and the scanner are read from
that same tree, so the model always matches the engine; the scanner builds
its oxc binary there on first use):

```sh
export ROFL_BIN=/path/to/rofl/rust/target/fast/rofl   # in its tree, with volumes
node --experimental-strip-types --no-warnings --test test/pods.test.ts test/pods-probe.test.ts   # the oracle, ~16 s
npm run mutants -- --only P1,P2                                                                   # its planted faults, all red
node --experimental-strip-types --no-warnings scripts/pods-cost.ts DIR 3                          # the cost on a corpus
```

The test and the cost script stand the federation up with
`test/pods-harness.ts` (`Federation.start(root, pods)`): it scans the corpus
with that tree's scanner (models/lang/js/scanner/cli.ts), evaluates under
its JS model (`models/lang/js/js.files`, the question named by `asks`), cuts the facts by file
(`splitFacts`: a node id's prefix `n<16 hex>_` names its file), writes the
corpus in path order (`corpusText`: a file's place is its index, a pod's block
a run of them, `podSize`), stands up a pod per block and the root at once
(`EngineNode.start`), publishes the decode rule on the coordinator and its
first answers, and subscribes.

**The oracle** (`test/pods.test.ts`): the corpus scanned anew and evaluated in
one engine answers the question; after the load, an edit that moves only its
own file's rows, an edit on one pod that moves what files of the other pod
offer (a function renamed behind `export *`), a deletion and a new file, the
subscriber's rows equal it, row for row; all but the new file go by levels.
A pod that reaches its wall (`budget`) refuses, and the federation refuses to
stand up, naming the wall. The planted
faults `P1` (the coordinator never retires an answer) and `P2` (the corpus
laid in another order than the files' places) turn it red.

## 12. Moving a node written before the rename

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
