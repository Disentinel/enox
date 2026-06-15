# Integrating the Enterprise Smart Node with Claude Code

This file is a **ready-to-paste prompt**. Open a Claude Code session in the
directory where you want the MCP server registered (the directory whose
`.mcp.json` should gain the server), paste the block below, and answer the
questions it asks. It will build the image, run the container, register the MCP
server, verify the tool list, and create a test user + token.

> Prerequisites: Docker running locally, and you are in a clone of this repo (the
> `Dockerfile` is in the current directory or you know the path to it).

---

## ⬇ Paste everything between the lines into Claude Code ⬇

---

You are deploying the **Enterprise Smart Node** (a self-hosted knowledge-graph
MCP server) for me, semi-interactively. Work step by step and STOP to ask me the
questions below before doing anything irreversible. Do not invent values.

**Step 0 — gather inputs (ask me, then echo back what you'll use):**

1. **Host / domain** the node will be reachable at (e.g. `localhost`, or
   `enox.internal.acme.example`). Default: `localhost`.
2. **Port** to expose. Default: `3700`.
3. **First admin username**. Default: `admin`.
4. **First admin token** — ask me to paste a long random secret, or offer to
   generate one with `openssl rand -base64 32`. This becomes `ADMIN_TOKEN`.
5. **Path to this repo** (where the `Dockerfile` is). Default: current directory.
6. **Node mode**: `private` (auth required — recommended) or `public`
   (read-only open). Default: `private`.

Echo the final values back to me as a short table and wait for my confirmation
before continuing.

**Step 1 — build the image:**

```bash
docker build -t enox-smart-node <REPO_PATH>
```

Note the build prewarms the all-MiniLM model into the image, so it takes a few
minutes. If the build fails on the model bake with a TLS/certificate error, tell
me — I may be behind a corporate DLP proxy and we'll add my corporate CA via
`NODE_EXTRA_CA_CERTS` (see the repo README; never disable TLS verification).

**Step 2 — run the container with a persistent volume + bootstrap env:**

```bash
docker volume create enox-data
docker rm -f enox 2>/dev/null || true
docker run -d --name enox \
  -p <PORT>:3700 \
  -v enox-data:/data \
  -e NODE_MODE=<MODE> \
  -e ADMIN_USER=<ADMIN_USER> \
  -e ADMIN_TOKEN=<ADMIN_TOKEN> \
  enox-smart-node
```

Then wait for health and confirm the admin bootstrap happened:

```bash
for i in $(seq 1 30); do
  curl -fsS http://<HOST>:<PORT>/health && break || sleep 2
done
docker logs enox 2>&1 | grep -E '\[auth\]|listening'
```

Confirm `/health` returns `{"status":"ok",...}` and the logs show the admin user
was bootstrapped. Authenticate a read to prove the token works:

```bash
curl -fsS http://<HOST>:<PORT>/api/nodes \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**Step 3 — register the MCP server in MY `.mcp.json`:**

The node speaks MCP over StreamableHTTP at `http://<HOST>:<PORT>/mcp` with a
bearer token. Add (or merge) this entry into the `.mcp.json` in the current
directory — preserve any existing servers, do not clobber the file:

```json
{
  "mcpServers": {
    "enox": {
      "type": "http",
      "url": "http://<HOST>:<PORT>/mcp",
      "headers": {
        "Authorization": "Bearer <ADMIN_TOKEN>"
      }
    }
  }
}
```

If a `.mcp.json` already exists, read it, merge the `enox` key into
`mcpServers`, and write it back. Tell me the final file path.

**Step 4 — verify `tools/list` returns the expected tools.**

Hit the MCP endpoint directly to confirm the server lists its tools (this is the
real `tools/list` JSON-RPC call over StreamableHTTP):

```bash
curl -fsS http://<HOST>:<PORT>/mcp \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Confirm the response lists these 14 tools (names must all appear):
`query_graph`, `add_assertion`, `update_assertion`, `delete_assertion`,
`graph_stats`, `semantic_search`, `recent_activity`, `update_node`, `recall`,
`remember`, `explore`, `traverse`, `batch_assertions`, `decide`.

If any are missing, stop and show me the raw response.

**Step 5 — create a test user + token** (proves the admin API works):

```bash
# Create a member user
curl -fsS -X POST http://<HOST>:<PORT>/api/admin/users \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"username":"test-user","role":"member"}'

# Issue a token for that user (capture the user id from the response above)
curl -fsS -X POST http://<HOST>:<PORT>/api/admin/tokens \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<USER_ID_FROM_PREVIOUS_RESPONSE>","label":"smoke-test"}'
```

The token is returned **once** in the response — show it to me and remind me it
cannot be recovered later (only its hash is stored). Then prove it authenticates:

```bash
curl -fsS http://<HOST>:<PORT>/api/nodes \
  -H "Authorization: Bearer <TEST_USER_TOKEN>"
```

> If the exact admin endpoint shapes differ, inspect them: the user/token CRUD
> lives under `/api/admin/{users,tokens}` (see `src/auth/router.ts`) and the
> admin console at `http://<HOST>:<PORT>/admin` does the same operations in a UI
> — fall back to the console if a curl call shape is off, and tell me.

**Step 6 — final report.** Summarize for me:
- the image tag, container name, port, and volume;
- the `.mcp.json` path you edited and the server name (`enox`);
- that `tools/list` returned all 14 tools (or which were missing);
- the test user and its token (shown once);
- a reminder to restart Claude Code so it picks up the new MCP server, and to
  rotate the admin token out of `.mcp.json` into a per-user token for daily use.

---

## ⬆ End of paste ⬆

---

### After it finishes

- Restart Claude Code so it reloads `.mcp.json` and connects to the `enox` MCP
  server. The 14 tools become available to the agent.
- For day-to-day use, prefer a **per-user token** (created in Step 5 / the admin
  console) over the admin token in `.mcp.json`.
- The graph explorer UI is at `http://<HOST>:<PORT>/` and the admin console at
  `http://<HOST>:<PORT>/admin`.
