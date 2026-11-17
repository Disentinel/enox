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

## 9. Moving a node written before the rename

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
