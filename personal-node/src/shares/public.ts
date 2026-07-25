import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from '../config.js';
import { shareAuth } from './auth.js';
import { getSnapshotStore } from './cache.js';
import { buildShareSummary } from './summary.js';
import { buildShareLandingMarkdown } from './markdown.js';
import { buildLandingHtml } from './landing-html.js';
import { buildReceiptData } from './receipt-data.js';
import { createShareMcpServer } from './mcp-server.js';
import { createShareApiRouter } from './api-router.js';
import { loadShareLayout } from './snapshot.js';
import { buildShareManifest } from './manifest.js';

// Public share-facing routes: the agent-native landing page, the plain-HTTP
// read API, and the per-share MCP endpoint. All use shareAuth (the share's own
// token), never the main requireAuth — these must be mounted outside
// app.use(['/mcp','/sse',...], requireAuth).
export function mountShareRoutes(app: Express): void {
  app.use('/share/:id', shareCors);
  mountShareLanding(app);
  app.use('/share/:id/api', shareAuth, createShareApiRouter());
  mountShareMcp(app);
  mountShareManifestAlias(app);
  // Must be registered LAST: a catch-all for anything under /share/:id/* that
  // none of the routes above matched (see mountShareNotFound's own comment).
  mountShareNotFound(app);
}

// Browser-based agents (a web chat agent's fetch tool) need to be able to call
// these cross-origin. GET-only, so this is intentionally permissive — there is
// no cookie/session auth here to protect against CSRF, only the share's own
// bearer-style token, which a wildcard origin doesn't expose to third parties.
function shareCors(req: Request, res: Response, next: NextFunction): void {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

function mountShareLanding(app: Express): void {
  app.get('/share/:id', shareAuth, async (req, res) => {
    const share = res.locals.share!;
    const shareId = res.locals.shareId!;
    const store = getSnapshotStore(shareId, share.name);
    if (!store) {
      res.status(404).json({ error: 'Share snapshot not found — try POST /api/shares/:id/refresh' });
      return;
    }

    const config = loadConfig();
    const mcpUrl = `${config.publicBaseUrl}/share/${shareId}/mcp?token=${share.token}`;
    const apiBaseUrl = `${config.publicBaseUrl}/share/${shareId}/api`;
    const landingUrl = `${config.publicBaseUrl}/share/${shareId}?token=${share.token}`;
    const manifestUrl = `${config.publicBaseUrl}/share/${shareId}/manifest.json?token=${share.token}`;

    // Discovery for a client that never negotiates content type and never
    // reads the body at all (a HEAD, or a GET it doesn't bother parsing): an
    // RFC 8288 Link header pointing at the manifest, present on every
    // representation of the share root below (html/json/markdown alike) —
    // absolute and already carrying the token, so it's directly fetchable.
    res.setHeader('Link', `<${manifestUrl}>; rel="describedby"; type="application/json"`);

    // Computed once and handed to markdown/HTML/manifest alike, so none of
    // the three can ever disagree on counts/dates.
    const summary = await buildShareSummary(share, store);

    // Content negotiation on the share root — one canonical URL, three
    // representations. A ?format= query param is a deliberate override for a
    // client that finds a query param easier to set than an Accept header —
    // it wins over Accept entirely when present. The legacy .md path suffix
    // (shareAuth's wantsMarkdownSuffix) keeps forcing markdown as before,
    // ahead of ?format= too. Absent either, Accept decides: text/html is the
    // human receipt, application/json is the machine manifest (see
    // manifest.ts) — the contract an agent should parse, NOT the markdown
    // below — and everything else (missing Accept, */*, text/markdown, an
    // agent that didn't bother to negotiate) gets the markdown "ready
    // prompt", which stays a human/narrative convenience, never the thing an
    // agent should treat as authoritative.
    const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : undefined;
    const accept = req.headers.accept ?? '';

    let mode: 'html' | 'json' | 'markdown';
    if (res.locals.wantsMarkdownSuffix) mode = 'markdown';
    else if (format === 'json') mode = 'json';
    else if (format === 'html') mode = 'html';
    else if (format === 'md') mode = 'markdown';
    else if (accept.includes('text/html')) mode = 'html';
    else if (accept.includes('application/json')) mode = 'json';
    else mode = 'markdown';

    if (mode === 'html') {
      const layout = loadShareLayout(shareId);
      const data = await buildReceiptData(
        share, summary, store, layout,
        { landingUrl, apiPath: apiBaseUrl, mcpUrl, token: share.token },
        config.publicOwnerName,
      );
      const html = buildLandingHtml({ share, data });
      // buildLandingHtml (landing-html.ts) owns the page shell; the
      // describedby <link> is spliced in here instead, right next to the
      // identical Link header above, both pointing at the same manifestUrl
      // computed once. Targets the literal opening <head> tag — replace()
      // with a string pattern (not a /g regex) only ever touches the first
      // match, which is always the real document head.
      const withManifestLink = html.replace('<head>', `<head>\n<link rel="describedby" href="${manifestUrl}" type="application/json">`);
      res.type('html').send(withManifestLink);
    } else if (mode === 'json') {
      const manifest = await buildShareManifest(shareId, share, summary, store);
      res.json(manifest);
    } else {
      const markdown = await buildShareLandingMarkdown(share, store, summary, { mcpUrl, apiBaseUrl, token: share.token });
      res.type('text/markdown').send(`Machine manifest: ${manifestUrl}\n\n${markdown}`);
    }
  });
}

interface ShareSession {
  transport: StreamableHTTPServerTransport;
  shareId: string;
}

function mountShareMcp(app: Express): void {
  const sessions = new Map<string, ShareSession>();

  app.post('/share/:id/mcp', shareAuth, async (req, res) => {
    const shareId = res.locals.shareId!;
    const share = res.locals.share!;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (session.shareId !== shareId) {
        res.status(400).json({ error: 'Session does not belong to this share' });
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    const store = getSnapshotStore(shareId, share.name);
    if (!store) {
      res.status(404).json({ error: 'Share snapshot not found — try POST /api/shares/:id/refresh' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, shareId });
        console.log(`[share/mcp] session ${sid} initialized for share ${shareId}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      console.log(`[share/mcp] session ${sid} closed`);
    };

    const server = createShareMcpServer(store, share);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/share/:id/mcp', shareAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const session = sessions.get(sessionId);
    if (!session || session.shareId !== res.locals.shareId) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.delete('/share/:id/mcp', shareAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const session = sessions.get(sessionId);
    if (!session || session.shareId !== res.locals.shareId) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    await session.transport.handleRequest(req, res);
    sessions.delete(sessionId);
  });
}

// Stable aliases for the manifest, for a client that fetches by convention
// (GET /<base>/manifest or /manifest.json) rather than doing content
// negotiation or knowing about /api — both paths are common guesses for an
// agent that read "manifest" somewhere and didn't see the .json extension
// mentioned. Both build the exact same object as Accept: application/json on
// the root and GET /share/:id/api.
function mountShareManifestAlias(app: Express): void {
  app.get(['/share/:id/manifest', '/share/:id/manifest.json'], shareAuth, async (_req, res) => {
    const share = res.locals.share!;
    const shareId = res.locals.shareId!;
    const store = getSnapshotStore(shareId, share.name);
    if (!store) {
      res.status(404).json({ error: 'Share snapshot not found — try POST /api/shares/:id/refresh' });
      return;
    }
    const summary = await buildShareSummary(share, store);
    const manifest = await buildShareManifest(shareId, share, summary, store);
    res.json(manifest);
  });
}

// Anything under /share/:id/* that isn't one of the routes registered above
// (the root, /api/*, /mcp, /manifest.json) currently falls through past all
// of them to index.ts's SPA catch-all, which serves the client's index.html
// with a 200 — the same class of bug as the .well-known/oauth-* fix in
// index.ts. An agent probing plausible-looking paths (/summary, /manifest,
// /schema — anything not nested under /api) gets back HTML and reasonably
// concludes there is no machine interface here, when there is one, just not
// at that path. shareAuth runs first so an unknown path under a revoked/
// expired/wrong-token share still reports 410/401 rather than masking it
// with a generic 404.
function mountShareNotFound(app: Express): void {
  app.all('/share/:id/{*path}', shareAuth, (_req, res) => {
    res.status(404).json({
      error: 'Unknown share endpoint',
      hint: 'see the manifest at ./api or send Accept: application/json to the share root',
    });
  });
}
