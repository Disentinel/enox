// Human-facing share receipt page. This is an integration of the approved
// claude.ai/design mock (share-receipt.html, saved for reference at
// scratchpad/design-v1/) — markup, CSS, and client JS are ported closely from
// that file. What this module adds on top:
//   - server-side templating of `const DATA = {...}` from the real share
//     (src/shares/receipt-data.ts builds the plain-object shape; this file
//     only JSON.stringifies it)
//   - `<script>...</script>` XSS escaping on the embedded JSON: any `<` in
//     user content becomes `<`, so a node named `</script><script>...`
//     can't break out of the data blob
//   - the TYPE map generalized from the mock's 4 hardcoded node types to all
//     of NODE_TYPES via src/shares/graph-colors.ts (same visual language,
//     more slots), built server-side for only the types present in this share
//   - a "no-graph" fallback the mock doesn't have: shares over MAX_SVG_NODES
//     get positions/nodes/edges omitted from DATA, the SVG stage is hidden,
//     the floating cards drop to a static stacked flow (reusing the mock's
//     own mobile stacked-layout rules via a `.no-graph` class), and
//     fetchNodeDetail/searchNodes switch from local DATA lookups to the
//     share's live HTTP API
import type { ShareRecord } from './types.js';
import type { ReceiptData } from './receipt-data.js';
import { buildTypeMapLiteral, cssVarsBlock } from './graph-colors.js';
import { renderArtifactBody } from './doc-render.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface LandingHtmlOptions {
  share: ShareRecord;
  data: ReceiptData;
}

export function buildLandingHtml(opts: LandingHtmlOptions): string {
  const { share, data } = opts;
  const hasGraph = !!data.positions;
  const hasArtifacts = data.artifacts.length > 0;

  const typesPresent = new Set(Object.keys(data.share.nodes_by_type));
  const typeMapLiteral = buildTypeMapLiteral(typesPresent);

  // XSS-safety lesson from this session: `<` in embedded JSON must become
  // `<` so no user-controlled string (a node name, description, etc.)
  // can close the enclosing <script> tag early.
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const typeJson = JSON.stringify(typeMapLiteral).replace(/</g, '\\u003c');

  // renderArtifactBody is inlined into the client script via .toString() (see
  // below) so the doc-render.test.ts unit tests exercise the exact code that
  // runs in the browser. Under this project's tsc build that .toString() is
  // clean, but under the tsx/esbuild dev runner (`npm run dev`) esbuild
  // injects `__name(fn, "fn")` calls after each nested function declaration,
  // for keeping .name in stack traces — a call to a module-scope helper that
  // does not exist once the function's source is lifted out and embedded
  // standalone in the page. Left in, every doc render throws immediately on
  // load and silently falls back to "Failed to load this document." Stripping
  // these call statements is a no-op against the tsc output and makes the
  // embedded copy self-contained either way.
  const renderArtifactBodySource = renderArtifactBody.toString().replace(/__name\([^,]+,\s*"[^"]*"\);?/g, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(share.name)} — shared knowledge graph</title>
<style>
:root{
  --bg:#0a0f14; --bg2:#0e151c; --panel:#101922; --panel2:#141f2a;
  --line:#1d2b38; --line2:#27394a;
  --text:#d7e3ec; --muted:#8aa0b2; --faint:#5f7484;
  --accent:#3fd6ee; --accent-dim:#1d8ba0; --accent-glow:rgba(63,214,238,.14);
  --btn-text:#04252c;
${cssVarsBlock('dark')}
  --code-bg:#0b1219; --halo:#0a0f14;
  --shadow:0 8px 28px rgba(0,0,0,.45);
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f4f7f9; --bg2:#eef2f5; --panel:#ffffff; --panel2:#f7fafb;
    --line:#dde5ea; --line2:#c9d5dd;
    --text:#1b2831; --muted:#546876; --faint:#7d8f9c;
    --accent:#0f93ac; --accent-dim:#0f93ac; --accent-glow:rgba(15,147,172,.10);
    --btn-text:#f2fbfd;
${cssVarsBlock('light')}
    --code-bg:#f0f4f6; --halo:#ffffff;
    --shadow:0 6px 20px rgba(20,40,50,.10);
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  overflow-x:hidden;
}
a{color:var(--accent); text-decoration:none}
a:hover{color:var(--accent); text-decoration:underline}
.wrap{max-width:1060px; margin:0 auto; padding:28px 20px 40px}
@media (min-width:1101px){ body{overflow:hidden; height:100vh} }
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

header{position:relative}
.storyline{color:var(--accent); font-size:12px; letter-spacing:.08em; text-transform:uppercase; font-weight:600; margin:0 0 8px}
h1{font-size:clamp(19px,3vw,25px); line-height:1.25; margin:0 0 6px; overflow-wrap:anywhere; text-wrap:balance}
.desc{color:var(--muted); margin:0; font-size:13.5px; text-wrap:pretty}

.receipt{
  display:flex; flex-wrap:wrap; gap:8px 20px; align-items:baseline;
  margin:16px 0 0; padding:12px 14px;
  background:var(--code-bg); border:1px solid var(--line); border-radius:10px;
}
.receipt .stat b{font-size:17px; font-weight:700; color:var(--text)}
.receipt .stat span{color:var(--muted); font-size:13px; margin-left:5px}
.receipt .meta{color:var(--faint); font-size:13px}
.receipt .meta b{color:var(--muted); font-weight:600}

.actions{margin:18px 0 0}
#copyAgent{
  display:inline-flex; align-items:center; gap:9px;
  background:var(--accent); color:var(--btn-text);
  border:0; border-radius:9px; padding:12px 20px;
  font:600 15px/1 system-ui,sans-serif; cursor:pointer;
  box-shadow:0 0 0 1px var(--accent-dim), 0 4px 18px var(--accent-glow);
}
#copyAgent:hover{filter:brightness(1.08)}
#copyAgent:active{transform:translateY(1px)}
.copy-hint{color:var(--faint); font-size:12px; display:block; margin-top:8px}
details.conn{margin-top:12px}
details.conn>summary{
  color:var(--muted); font-size:13px; cursor:pointer; width:fit-content;
  list-style:none; display:flex; gap:6px; align-items:center;
}
details.conn>summary::before{content:"▸"; color:var(--faint); font-size:11px}
details.conn[open]>summary::before{content:"▾"}
details.conn>summary:hover{color:var(--text)}
.conn-body{margin-top:10px; display:grid; gap:10px}
.codeblock{background:var(--code-bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; position:relative}
.codeblock .lbl{font-size:11px; color:var(--faint); letter-spacing:.05em; text-transform:uppercase; margin-bottom:4px}
.codeblock pre{margin:0; font-size:12.5px; white-space:pre-wrap; word-break:break-all; color:var(--text)}
.codeblock button{
  position:absolute; top:8px; right:8px; background:var(--panel2); color:var(--muted);
  border:1px solid var(--line2); border-radius:6px; padding:3px 9px; font-size:11px; cursor:pointer;
}
.codeblock button:hover{color:var(--accent); border-color:var(--accent-dim)}

section{margin-top:34px}
h2{font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); font-weight:700; margin:0 0 12px}

.stage{width:100%}
#graph{position:fixed; inset:0; width:100%; height:100%; touch-action:none; cursor:grab; background:var(--bg); z-index:0}
#graph.panning{cursor:grabbing}
.hcard{position:fixed; z-index:3; top:16px; left:16px; width:min(440px, calc(100vw - 32px));
  max-height:calc(100vh - 32px); overflow:auto;
  background:color-mix(in srgb, var(--panel) 90%, transparent); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  border:1px solid var(--line); border-radius:12px; padding:20px; box-shadow:var(--shadow)}
.bandctl{position:fixed; left:16px; bottom:14px; z-index:2; display:flex; flex-direction:column; gap:8px; align-items:flex-start}
.ctlrow{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
.legend{display:flex; flex-wrap:wrap; gap:5px 14px; font-size:11.5px; color:var(--muted);
  background:color-mix(in srgb, var(--panel) 78%, transparent); padding:5px 9px; border-radius:7px}
.legend i{display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; vertical-align:-1px}
#zoomReset{background:var(--panel2); border:1px solid var(--line2); white-space:nowrap;
  color:var(--muted); font-size:11.5px; padding:4px 10px; border-radius:6px; cursor:pointer}
#zoomReset:hover{color:var(--accent); border-color:var(--accent-dim)}
.gnode{cursor:pointer}
.gnode circle{stroke:var(--bg); stroke-width:1.5; transition:opacity .15s}
.gnode text{font:10px ui-monospace,Menlo,Consolas,monospace; fill:var(--muted); paint-order:stroke; stroke:var(--halo); stroke-width:3px; stroke-linejoin:round; pointer-events:none; transition:opacity .15s}
.gedge{stroke:var(--line2); stroke-width:1.4; transition:opacity .15s, stroke .15s}
svg.hovering .gnode:not(.hl) circle, svg.hovering .gnode:not(.hl) text{opacity:.22}
svg.hovering .gedge:not(.hl){opacity:.15}
.gedge.hl{stroke:var(--accent)}
.gnode.selected circle{stroke:var(--accent); stroke-width:2.5}
.gnode.selected text{fill:var(--text)}

.explorer{position:fixed; z-index:3; top:16px; right:16px; bottom:16px; width:min(380px, calc(100% - 32px));
  background:color-mix(in srgb, var(--panel) 90%, transparent); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  border:1px solid var(--line); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px;
  overflow-y:auto; box-shadow:var(--shadow)}
@media (max-width:1100px){
  .stage{display:flex; flex-direction:column}
  #graph{position:static; width:100%; height:46vh; min-height:300px}
  .hcard{position:static; order:-1; width:auto; margin:14px; max-height:none; backdrop-filter:none; background:var(--panel)}
  .explorer{position:static; width:auto; margin:0 14px 14px; max-height:420px; backdrop-filter:none; background:var(--panel)}
  .bandctl{position:static; padding:0 14px 14px}
}
/* No-graph fallback (shares over the SVG node threshold): same idiom as the
   mobile stacked layout above, applied unconditionally regardless of
   viewport width, and the page is allowed to scroll normally instead of the
   fixed-viewport-with-floating-cards treatment the graph view uses. */
body.no-graph{overflow:auto !important; height:auto !important}
body.no-graph .stage{display:flex; flex-direction:column}
body.no-graph #graph{display:none}
body.no-graph .hcard{position:static; order:-1; width:auto; margin:14px; max-height:none; backdrop-filter:none; background:var(--panel)}
body.no-graph .explorer{position:static; width:auto; margin:0 14px 14px; max-height:none; backdrop-filter:none; background:var(--panel)}
body.no-graph .bandctl{position:static; padding:0 14px 14px}
body.no-graph #zoomReset{display:none}
#search{
  width:100%; background:var(--code-bg); border:1px solid var(--line); border-radius:7px;
  color:var(--text); padding:7px 10px; font:13px system-ui,sans-serif;
}
#search:focus{outline:none; border-color:var(--accent-dim)}
#searchResults{display:flex; flex-direction:column; gap:4px}
#searchResults button{
  text-align:left; background:none; border:0; color:var(--muted); font-size:12.5px; cursor:pointer;
  padding:3px 4px; border-radius:5px; overflow-wrap:anywhere;
}
#searchResults button:hover{background:var(--panel2); color:var(--text)}
.badge{display:inline-block; font-size:10.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; padding:2px 8px; border-radius:99px; border:1px solid; width:fit-content}
#exName{font-size:15.5px; font-weight:650; line-height:1.35; margin:0; overflow-wrap:anywhere; word-break:break-word}
.exMeta{font-size:12px; color:var(--faint)}
#exDesc{font-size:13px; color:var(--muted); margin:0; text-wrap:pretty}
.rel-h{font-size:11px; color:var(--faint); letter-spacing:.06em; text-transform:uppercase; margin:4px 0 2px}
.rel{font-size:12.5px; color:var(--muted); overflow-wrap:anywhere}
.rel .rname{color:var(--faint); font-family:ui-monospace,Menlo,monospace; font-size:11.5px}
.rel .rby{color:var(--faint); font-size:11px}
.rctx{color:var(--faint); font-size:12px; margin:2px 0 0; padding-left:12px; overflow-wrap:anywhere; text-wrap:pretty}
.rel a{cursor:pointer}
#exSource{font-size:12.5px; margin:2px 0 0}
.ex-empty{color:var(--faint); font-size:13px; margin:auto 0; text-align:center; padding:20px 8px}

.docs{margin-top:22px}
.doc-tree{display:flex; flex-direction:column; gap:2px; font-size:13px}
.doc-folder{margin:2px 0}
.doc-folder>summary{cursor:pointer; color:var(--muted); padding:4px 2px; list-style:none; display:flex; align-items:center; gap:6px}
.doc-folder>summary::before{content:"▸"; color:var(--faint); font-size:10px}
.doc-folder[open]>summary::before{content:"▾"}
.doc-folder>.doc-tree{padding-left:16px; border-left:1px solid var(--line); margin-left:5px; margin-top:2px}
.doc-leaf{cursor:pointer; color:var(--text); padding:5px 6px; border-radius:6px; display:flex; align-items:center; gap:7px; overflow-wrap:anywhere}
.doc-leaf:hover{background:var(--panel2)}
.doc-leaf.selected{background:var(--panel2); color:var(--accent)}
.doc-leaf .ic{color:var(--faint); font-size:11px; flex:none}

/* Document reading pane — shared by the inline explorer view (#docBody,
   narrow: the explorer panel is min(380px, ...) wide, so 70ch never binds
   there) and the full-screen overlay (#docOverlayBody, wide: this is where
   the cap actually keeps prose lines from stretching edge-to-edge). */
.ex-doc-head{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:2px}
#docFullscreen{background:none; border:1px solid var(--line2); border-radius:6px; color:var(--muted); font-size:13px; line-height:1; padding:3px 7px; cursor:pointer; flex:none}
#docFullscreen:hover{color:var(--accent); border-color:var(--accent-dim)}
.doc-content{max-width:70ch; font-size:13.5px; line-height:1.62; color:var(--text)}
.doc-content.doc-loading,.doc-content.doc-error{color:var(--faint); font-size:12.5px; max-width:none}
.doc-content>*:first-child{margin-top:0}
.doc-content h1,.doc-content h2,.doc-content h3,.doc-content h4,.doc-content h5,.doc-content h6{
  color:var(--text); letter-spacing:normal; text-transform:none; overflow-wrap:anywhere;
}
.doc-content h1{font-size:19px; font-weight:750; margin:0 0 10px}
.doc-content h2{font-size:16px; font-weight:700; margin:22px 0 8px}
.doc-content h3{font-size:14.5px; font-weight:700; margin:18px 0 6px}
.doc-content h4,.doc-content h5,.doc-content h6{font-size:13.5px; font-weight:650; margin:16px 0 6px}
.doc-content p{margin:0 0 12px; overflow-wrap:anywhere}
.doc-content ul{margin:0 0 12px; padding-left:22px}
.doc-content li{margin:3px 0}
.doc-content blockquote{margin:0 0 12px; padding:1px 0 1px 14px; border-left:3px solid var(--line2); color:var(--muted)}
.doc-content blockquote p{margin:0}
.doc-content code{font-family:ui-monospace,Menlo,monospace; background:var(--panel2); padding:1.5px 6px; border-radius:5px; font-size:12.5px}
.doc-content pre{background:var(--panel2); border:1px solid var(--line2); border-radius:8px; padding:10px 13px; overflow-x:auto; margin:0 0 12px; max-width:100%; line-height:1.5}
.doc-content pre code{background:none; padding:0; border-radius:0; font-size:12.5px}
.doc-content a{color:var(--accent); text-decoration:none}
.doc-content a:hover{text-decoration:underline}

.doc-overlay{position:fixed; inset:0; z-index:50; background:rgba(6,10,14,.6); display:flex; align-items:flex-start; justify-content:center; padding:5vh 20px; overflow:auto}
.doc-overlay.hidden{display:none}
.doc-overlay-panel{background:var(--panel); border:1px solid var(--line); border-radius:14px; max-width:min(760px, 100%); width:100%; padding:26px 30px 32px; box-shadow:var(--shadow); position:relative; overflow-x:auto}
.doc-overlay-head{display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid var(--line)}
.doc-overlay-head h2{margin:0; font-size:16px; letter-spacing:normal; text-transform:none; color:var(--text); font-weight:700; overflow-wrap:anywhere}
#docOverlayClose{background:var(--panel2); border:1px solid var(--line2); border-radius:7px; color:var(--muted); width:30px; height:30px; font-size:14px; cursor:pointer; flex:none}
#docOverlayClose:hover{color:var(--accent); border-color:var(--accent-dim)}
@media (max-width:600px){
  .doc-overlay{padding:0}
  .doc-overlay-panel{max-width:100%; min-height:100vh; border-radius:0; padding:18px 16px 28px}
}
footer{font-size:12px; color:var(--faint)}
#toast{
  position:fixed; bottom:22px; left:50%; transform:translateX(-50%) translateY(8px);
  background:var(--panel2); border:1px solid var(--accent-dim); color:var(--text);
  padding:9px 18px; border-radius:9px; font-size:13.5px; opacity:0; pointer-events:none;
  transition:opacity .2s, transform .2s; box-shadow:var(--shadow); max-width:90vw;
}
#toast.show{opacity:1; transform:translateX(-50%) translateY(0)}
</style>
</head>
<body${hasGraph ? '' : ' class="no-graph"'}>
<script>
// Runs before the rest of the body is parsed, to avoid a flash of the wrong
// layout: a share with embedded graph data still isn't drawn as an SVG on a
// narrow viewport — the force-packed layout of sentence-length node labels
// renders illegibly small there (font-size is in viewBox user-units, so it
// shrinks with the SVG's rendered width; there is no server-side signal for
// viewport width, so this decision has to be made here, synchronously, before
// paint). Below 701px this always matches the >400-node fallback exactly:
// static stacked receipt + search + explorer, no graph.
if (window.matchMedia && !window.matchMedia("(min-width: 701px)").matches) {
  document.body.classList.add("no-graph");
}
</script>
<div id="root">
<section id="exploreSec" class="stage">
  <svg id="graph" role="img" aria-label="Knowledge graph"></svg>
  <aside class="hcard">
  <header>
    <p class="storyline" id="storyline"></p>
    <h1 id="shareName"></h1>
    <p class="desc" id="shareDesc"></p>
    <div class="receipt" id="receipt"></div>
    <div class="actions">
      <button id="copyAgent"><svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4.5" y="4.5" width="9" height="9" rx="1.5"/><path d="M10.5 4.5v-2a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 2.5V9A1.5 1.5 0 0 0 3 10.5h1.5" stroke-linecap="round"/></svg><span>Copy for agent</span></button>
      <span class="copy-hint">copies a ready prompt — paste it into any AI chat</span>
      <details class="conn">
        <summary>Connection details for agents</summary>
        <div class="conn-body" id="connBody"></div>
      </details>
    </div>
    ${hasArtifacts ? `<section class="docs" id="docsSection">
      <h2>Documents (${data.artifacts.length})</h2>
      <div class="doc-tree" id="docTree"></div>
    </section>` : ''}
  </header>
  </aside>
  <div class="explorer">
    <input id="search" type="search" placeholder="Find an entity…" autocomplete="off">
    <div id="searchResults"></div>
    <div id="exBody" style="display:contents"></div>
  </div>
  <div class="bandctl">
    <div class="ctlrow"><div class="legend" id="legend"></div><button id="zoomReset" title="Reset view">reset view</button></div>
    <footer>Powered by <a href="https://github.com/Disentinel/enox" target="_blank" rel="noopener">Enox — Federated Knowledge Protocol</a></footer>
  </div>
</section>
</div>
${hasArtifacts ? `<div id="docOverlay" class="doc-overlay hidden" role="dialog" aria-modal="true">
  <div class="doc-overlay-panel">
    <div class="doc-overlay-head">
      <h2 id="docOverlayTitle"></h2>
      <button id="docOverlayClose" aria-label="Close">✕</button>
    </div>
    <div class="doc-content" id="docOverlayBody"></div>
  </div>
</div>` : ''}
<div id="toast"></div>

<script>
const DATA = ${dataJson};
const TYPE_RAW = ${typeJson};
const HAS_GRAPH = !!DATA.positions;

/* ---------- helpers ---------- */
const TYPE = TYPE_RAW;
const OTHER_TYPE = {label:"other", color:"var(--c-other)"};
function typeOf(t){ return TYPE[t] || OTHER_TYPE; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const trunc = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
const byId = Object.fromEntries(DATA.nodes.map(n => [n.id, n]));
const degree = {};
DATA.nodes.forEach(n => degree[n.id] = 0);
DATA.edges.forEach(e => { degree[e.source]++; degree[e.target]++; });

function apiUrl(path){
  const sep = path.indexOf("?") === -1 ? "?" : "&";
  return DATA.share.api_path + path + sep + "token=" + encodeURIComponent(DATA.share.token);
}
// LIVE-API: node detail lookup — local for graph-eligible shares (everything
// needed is already in DATA), real GET {api_base_url}/nodes/:id otherwise.
// Practical "is this a URL" check, mirroring src/crud/validators.ts's looksLikeUrl
// server-side: http(s)://, bare doi.org/... or arxiv.org/... (no scheme, as people
// paste them), else a WHATWG URL parse for anything else with an explicit scheme.
// A source_ref that fails this renders as plain text instead of a link.
function isUrlLike(s){
  if (!s) return false;
  if (/^https?:\\/\\//i.test(s)) return true;
  if (/^(doi\\.org\\/|arxiv\\.org\\/)/i.test(s)) return true;
  try { new URL(s); return true; } catch { return false; }
}
function sourceHref(s){ return /^https?:\\/\\//i.test(s) ? s : "https://" + s; }

function localNodeDetail(id){
  const n = byId[id];
  if (!n) return null;
  const outgoing = DATA.edges.filter(e => e.source === id).map(e => ({relation: e.relation, asserted_by: e.asserted_by, context: e.context, other: e.target, other_name: byId[e.target].name}));
  const incoming = DATA.edges.filter(e => e.target === id).map(e => ({relation: e.relation, asserted_by: e.asserted_by, context: e.context, other: e.source, other_name: byId[e.source].name}));
  return {id: n.id, type: n.type, name: n.name, description: n.description, source_ref: n.source_ref, domain: DATA.share.domains[0] || "", outgoing, incoming};
}
function remoteNodeDetail(id){
  return fetch(apiUrl("/nodes/" + encodeURIComponent(id)))
    .then(r => r.ok ? r.json() : null)
    .then(d => !d || !d.node ? null : {
      id: d.node.id, type: d.node.type, name: d.node.name, description: d.node.description, source_ref: d.node.source_ref, domain: d.node.domain,
      outgoing: (d.outgoing || []).map(e => ({relation: e.relation, asserted_by: e.asserted_by, context: e.context, other: e.target, other_name: e.target_name})),
      incoming: (d.incoming || []).map(e => ({relation: e.relation, asserted_by: e.asserted_by, context: e.context, other: e.source, other_name: e.source_name})),
    })
    .catch(() => null);
}
function fetchNodeDetail(id){ return HAS_GRAPH ? Promise.resolve(localNodeDetail(id)) : remoteNodeDetail(id); }
// LIVE-API: name search — local filter for graph-eligible shares, real GET
// {api_base_url}/search (embeddings) or /nodes (text) otherwise.
function searchNodes(q){
  q = (q || "").trim();
  if (!q) return Promise.resolve([]);
  if (HAS_GRAPH) return Promise.resolve(DATA.nodes.filter(n => n.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8));
  const endpoint = DATA.share.has_semantic_search ? "/search" : "/nodes";
  return fetch(apiUrl(endpoint + "?q=" + encodeURIComponent(q) + "&limit=8"))
    .then(r => r.ok ? r.json() : [])
    .then(d => (Array.isArray(d) ? d : (d.nodes || [])).slice(0, 8).map(n => ({id: n.id, type: n.type, name: n.name})))
    .catch(() => []);
}

/* ---------- header + receipt ---------- */
const S = DATA.share;
document.title = S.name + " — shared knowledge graph";
document.getElementById("storyline").textContent =
  (S.owner_name ? S.owner_name + " shared" : "Someone shared") + \` a slice of \${S.owner_possessive || "their"} knowledge graph with you — read-only\`;
document.getElementById("shareName").textContent = S.name;
document.getElementById("shareDesc").textContent = S.description;

const typeBreakdown = Object.entries(S.nodes_by_type)
  .map(([t, c]) => \`\${c} \${typeOf(t).label}\${c === 1 ? "" : "s"}\`).join(" · ");
document.getElementById("receipt").innerHTML = \`
  <span class="stat"><b>\${S.node_count}</b><span>entities</span></span>
  <span class="stat"><b>\${S.edge_count}</b><span>connections</span></span>
  <span class="stat"><b>\${S.domains.length}</b><span>domain\${S.domains.length === 1 ? "" : "s"}: \${esc(S.domains.join(", "))}</span></span>
  <span class="meta">\${esc(typeBreakdown)}</span>
  <span class="meta">snapshot taken <b>\${esc(S.snapshot_at)}</b></span>
  <span class="meta">\${S.expires_at ? \`link is live until <b>\${esc(S.expires_at)}</b>\` : "link <b>does not expire</b>"}</span>\`;

/* ---------- copy for agent ---------- */
function agentPrompt(){
  return \`You've been given read-only access to a slice of \${S.owner_name ? S.owner_name + "'s" : "someone's"} Enox knowledge graph.

Share: "\${S.name}"
\${S.description}
Contents: \${S.node_count} entities, \${S.edge_count} connections. Domains: \${S.domains.join(", ")}.
Snapshot taken \${S.snapshot_at}. \${S.expires_at ? "Link valid until " + S.expires_at + "." : "Link does not expire."}

Connect over HTTP (works with any agent that can fetch a URL):
API base: \${S.api_base_url}
Fetch the base URL for a JSON index of endpoints, then query entities and relations as needed.

If you support MCP, connect instead via:
\${S.mcp_url}

Use this graph as read-only context when answering my questions.\`;
}
function copyText(t, msg){
  const done = () => showToast(msg);
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
  } else fallbackCopy(t, done);
}
function fallbackCopy(t, done){
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch(e){}
  ta.remove(); done();
}
let toastTimer;
function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}
document.getElementById("copyAgent").addEventListener("click", () =>
  copyText(agentPrompt(), "Prompt copied — paste it into any AI chat"));

document.getElementById("connBody").innerHTML = \`
  <div class="codeblock"><div class="lbl">HTTP API base — works with any agent that can fetch a URL</div>
    <pre class="mono">\${esc(S.api_base_url)}</pre><button data-copy="\${esc(S.api_base_url)}">copy</button></div>
  <div class="codeblock"><div class="lbl">MCP endpoint — for agents with MCP support</div>
    <pre class="mono">\${esc(S.mcp_url)}</pre><button data-copy="\${esc(S.mcp_url)}">copy</button></div>\`;
document.getElementById("connBody").addEventListener("click", e => {
  const b = e.target.closest("button[data-copy]");
  if (b) copyText(b.dataset.copy, "Copied");
});

/* ---------- documents (artifact bodies: skill files, notes, etc.) ----------
   docTree only exists in the DOM when the server put artifacts in DATA (see
   landing-html.ts's hasArtifacts check) — guard on that rather than re-testing
   DATA.artifacts.length here, so the two can never disagree.
   Master-detail: the compact tree stays in the narrow hcard on the left;
   selecting a document renders it in the SAME wide #exBody panel used for
   node inspection (both are "inspector" content) — selectDoc()/selectNode()
   below call each other's clear*Selection() so only one is ever shown. Those
   functions are defined later, in the explorer section — safe to reference
   here ahead of their textual position because they're plain function
   declarations (hoisted), same as the existing svg pointerup handler below
   already forward-references selectNode(). */
const docTree = document.getElementById("docTree");
const ARTIFACTS = DATA.artifacts;
const ARTIFACTS_BY_ID = Object.fromEntries(ARTIFACTS.map(a => [a.id, a]));
let selectedDocId = null;
const docCache = {};
// Inlined from src/shares/doc-render.ts via .toString() at server-render
// time — this is the exact same function exercised by that module's own
// unit tests (doc-render.test.ts), not a hand-copied duplicate that could
// drift out of sync with what was actually tested.
const renderArtifactBody = ${renderArtifactBodySource};

function clearDocSelection(){
  selectedDocId = null;
  if (docTree) docTree.querySelectorAll(".doc-leaf.selected").forEach(el => el.classList.remove("selected"));
}

if (docTree){
  function buildDocTree(items){
    const root = {folders: {}, files: []};
    items.forEach(a => {
      const parts = (a.filename || a.title || a.id).split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length - 1; i++){
        const seg = parts[i];
        node.folders[seg] = node.folders[seg] || {folders: {}, files: []};
        node = node.folders[seg];
      }
      node.files.push({artifact: a, label: parts[parts.length - 1] || a.title});
    });
    return root;
  }
  function docTreeHtml(node){
    let out = "";
    Object.keys(node.folders).sort().forEach(name => {
      out += \`<details class="doc-folder"><summary>\${esc(name)}</summary><div class="doc-tree">\${docTreeHtml(node.folders[name])}</div></details>\`;
    });
    node.files.sort((a, b) => a.label.localeCompare(b.label)).forEach(f => {
      out += \`<div class="doc-leaf" data-id="\${esc(f.artifact.id)}"><span class="ic">▸</span><span>\${esc(f.label)}</span></div>\`;
    });
    return out;
  }
  docTree.innerHTML = docTreeHtml(buildDocTree(ARTIFACTS));
  docTree.addEventListener("click", e => {
    const leaf = e.target.closest(".doc-leaf");
    if (leaf) selectDoc(leaf.dataset.id, true);
  });
}

// Fetches + renders once per artifact id, then serves subsequent opens from
// docCache. A failed fetch is NOT cached (so a retry click can succeed once
// the network recovers) — the null return signals "show an error" to callers.
function loadDocHtml(id, meta){
  if (docCache[id] !== undefined) return Promise.resolve(docCache[id]);
  return fetch(apiUrl("/artifacts/" + encodeURIComponent(id) + "/raw"))
    .then(r => { if (!r.ok) throw new Error("fetch failed"); return r.text(); })
    .then(text => {
      const isMd = !!(meta && /markdown/i.test(meta.content_type));
      const html = renderArtifactBody(text, isMd);
      docCache[id] = html;
      return html;
    })
    .catch(() => null);
}

async function selectDoc(id, scroll){
  clearNodeSelection();
  selectedDocId = id;
  if (docTree) docTree.querySelectorAll(".doc-leaf").forEach(el => el.classList.toggle("selected", el.dataset.id === id));

  const meta = ARTIFACTS_BY_ID[id];
  const title = meta ? meta.title : id;
  const path = meta ? (meta.filename || meta.title) : id;
  exBody.innerHTML = \`
    <div class="ex-doc-head">
      <span class="badge" style="color:var(--accent); border-color:var(--accent)">document</span>
      <button id="docFullscreen" title="Open full screen" aria-label="Open full screen">⤢</button>
    </div>
    <p id="exName" title="\${esc(title)}">\${esc(trunc(title, 80))}</p>
    <div class="exMeta mono">\${esc(path)}</div>
    <div class="doc-content doc-loading" id="docBody">Loading…</div>\`;

  if (scroll) scrollExplorerIntoView();

  const rendered = await loadDocHtml(id, meta);
  // A newer selection (another doc, or a graph node) may have superseded this
  // one while the fetch was in flight — discard the stale result rather than
  // overwrite whatever the panel is showing now.
  if (selectedDocId !== id) return;
  const docBody = document.getElementById("docBody");
  if (!docBody) return;
  docBody.classList.remove("doc-loading");
  if (rendered === null){
    docBody.classList.add("doc-error");
    docBody.textContent = "Failed to load this document.";
  } else {
    docBody.innerHTML = rendered;
  }
  const fsBtn = document.getElementById("docFullscreen");
  if (fsBtn) fsBtn.addEventListener("click", () => { if (openDocOverlay) openDocOverlay(title, docBody.innerHTML); });
}

// Only reachable via a document's fullscreen button, so this markup only
// exists when hasArtifacts was true server-side (see landing-html.ts) — same
// condition docTree is gated on, so the two are always both present or both
// absent. openDocOverlay stays null (fsBtn guards on it above) if somehow not.
let openDocOverlay = null;
const docOverlay = document.getElementById("docOverlay");
if (docOverlay){
  const docOverlayBody = document.getElementById("docOverlayBody");
  const docOverlayTitle = document.getElementById("docOverlayTitle");
  openDocOverlay = function(title, html){
    docOverlayTitle.textContent = title;
    docOverlayBody.innerHTML = html;
    docOverlay.classList.remove("hidden");
  };
  function closeDocOverlay(){
    docOverlay.classList.add("hidden");
    docOverlayBody.innerHTML = "";
  }
  docOverlay.addEventListener("click", e => { if (e.target === docOverlay) closeDocOverlay(); });
  document.getElementById("docOverlayClose").addEventListener("click", closeDocOverlay);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !docOverlay.classList.contains("hidden")) closeDocOverlay();
  });
}

// Explorer is fixed (always fully visible, own internal scroll) on desktop
// with a graph; on mobile or a no-graph share it's a static block stacked
// below the hcard, which can be scrolled past the fold — bring it into view
// only in that stacked case.
function scrollExplorerIntoView(){
  const stacked = window.matchMedia("(max-width: 1100px)").matches || document.body.classList.contains("no-graph");
  if (!stacked) return;
  const ex = document.querySelector(".explorer");
  if (!ex) return;
  window.scrollTo({ top: ex.getBoundingClientRect().top + window.scrollY - 12, behavior: "smooth" });
}

/* ---------- graph layout: component packing + fit ---------- */
const svg = document.getElementById("graph");
const adj = {};
DATA.nodes.forEach(n => adj[n.id] = new Set());
DATA.edges.forEach(e => { adj[e.source].add(e.target); adj[e.target].add(e.source); });
let viewport = null;
const view = {x: 0, y: 0, k: 1};
const base = {tx: 0, ty: 0, s: 1};
const VB = {w: 1200, h: 640};
// HAS_GRAPH: this share's data is small enough to embed positions for at all.
// SHOW_GRAPH: whether to actually draw the SVG right now — additionally false
// on narrow viewports (the early inline script above already added
// body.no-graph in that case), where a force-packed graph of sentence-length
// labels is illegible regardless of how much data is available. Read the
// class rather than re-checking matchMedia here, so both reasons for
// no-graph (oversized share, narrow viewport) collapse to one flag.
const SHOW_GRAPH = HAS_GRAPH && !document.body.classList.contains("no-graph");

if (SHOW_GRAPH){
  const panelReserve = window.matchMedia("(min-width: 1101px)").matches
    ? Math.min(520, (432 / Math.max(window.innerWidth, 861)) * VB.w) : 0;
  function computeLayout(){
    const parent = {};
    const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
    DATA.nodes.forEach(n => parent[n.id] = n.id);
    DATA.edges.forEach(e => { parent[find(e.source)] = find(e.target); });
    const comps = {};
    DATA.nodes.forEach(n => { const r = find(n.id); (comps[r] = comps[r] || []).push(n.id); });

    const PX = 150, PY = 70, MIN = 120;
    const boxes = Object.values(comps).map(ids => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      ids.forEach(id => { const p = DATA.positions[id];
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
      let w = Math.max(x1 - x0, MIN) + PX * 2, h = Math.max(y1 - y0, MIN) + PY * 2;
      return {ids, x0, y0, w, h};
    }).sort((a, b) => b.w * b.h - a.w * a.h);

    const totalArea = boxes.reduce((s, b) => s + b.w * b.h, 0);
    const rowW = Math.sqrt(totalArea * (VB.w / VB.h)) * 1.15;
    let cx = 0, cy = 0, rowH = 0;
    const placed = {};
    boxes.forEach(b => {
      if (cx > 0 && cx + b.w > rowW){ cx = 0; cy += rowH; rowH = 0; }
      b.px = cx; b.py = cy;
      cx += b.w; rowH = Math.max(rowH, b.h);
      b.ids.forEach(id => {
        const p = DATA.positions[id];
        placed[id] = {x: b.px + (p.x - b.x0) + PX, y: b.py + (p.y - b.y0) + PY};
        const spanX = Math.max(...b.ids.map(i => DATA.positions[i].x)) - b.x0;
        const spanY = Math.max(...b.ids.map(i => DATA.positions[i].y)) - b.y0;
        placed[id].x += (b.w - PX * 2 - spanX) / 2;
        placed[id].y += (b.h - PY * 2 - spanY) / 2;
      });
    });

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    Object.values(placed).forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    const padX = Math.max(VB.w * 0.08, 118), padY = Math.max(VB.h * 0.08, 44);
    const iw = VB.w - 2 * padX - panelReserve, ih = VB.h - 2 * padY;
    const s = Math.min(iw / Math.max(x1 - x0, 1), ih / Math.max(y1 - y0, 1));
    const ox = Math.max(padX, (VB.w - panelReserve - (x1 - x0) * s) / 2), oy = (VB.h - (y1 - y0) * s) / 2;
    const out = {};
    Object.entries(placed).forEach(([id, p]) => out[id] = {x: (p.x - x0) * s + ox, y: (p.y - y0) * s + oy});
    return out;
  }
  const POS = computeLayout();
  const maxDeg = Math.max(1, ...Object.values(degree));
  const radius = id => Math.min(14, Math.max(5, 5 + 9 * Math.sqrt(degree[id] / maxDeg)));
  const labelAll = DATA.nodes.length <= 30;

  svg.setAttribute("viewBox", \`0 0 \${VB.w} \${VB.h}\`);

  let gHtml = \`<g id="viewport">\`;
  DATA.edges.forEach((e, i) => {
    const a = POS[e.source], b = POS[e.target];
    gHtml += \`<line class="gedge" data-e="\${i}" x1="\${a.x.toFixed(1)}" y1="\${a.y.toFixed(1)}" x2="\${b.x.toFixed(1)}" y2="\${b.y.toFixed(1)}"><title>\${esc(byId[e.source].name)} —\${esc(e.relation)}→ \${esc(byId[e.target].name)}</title></line>\`;
  });
  const circles = DATA.nodes.map(n => ({id: n.id, x: POS[n.id].x, y: POS[n.id].y, r: radius(n.id)}));
  const rectCircleHit = (lx, ly, half, c) => {
    const nx = Math.max(lx - half, Math.min(c.x, lx + half));
    const ny = Math.max(ly - 9, Math.min(c.y, ly + 2));
    return (nx - c.x) ** 2 + (ny - c.y) ** 2 < (c.r + 3) ** 2;
  };
  const rectRectHit = (a, b) =>
    a.x - a.half < b.x + b.half + 8 && b.x - b.half < a.x + a.half + 8 && Math.abs(a.y - b.y) < 12;
  const clampX = (x, half) => Math.min(VB.w - 6 - half, Math.max(6 + half, x));
  const labels = [];
  DATA.nodes
    .filter(n => labelAll || degree[n.id] >= maxDeg * 0.6)
    .sort((a, b) => POS[a.id].x - POS[b.id].x)
    .forEach(n => {
      const p = POS[n.id], r = radius(n.id), text = trunc(n.name, 36);
      const half = text.length * 6.1 / 2;
      const cands = [
        {x: p.x, y: p.y + r + 11},
        {x: p.x, y: p.y - r - 6},
        {x: p.x + r + 8 + half, y: p.y + 3},
        {x: p.x - r - 8 - half, y: p.y + 3},
        {x: p.x, y: p.y + r + 23},
        {x: p.x, y: p.y - r - 18},
      ];
      let pick = null, best = Infinity;
      for (const c of cands){
        const lx = clampX(c.x, half), cand = {x: lx, y: c.y, half};
        const score = circles.reduce((s, ci) => s + (ci.id !== n.id && rectCircleHit(lx, c.y, half, ci) ? 2 : 0), 0)
                    + labels.reduce((s, l) => s + (rectRectHit(cand, l) ? 1 : 0), 0);
        if (score < best){ best = score; pick = cand; if (score === 0) break; }
      }
      labels.push({id: n.id, text, half, x: pick.x, y: pick.y});
    });
  const labelBy = Object.fromEntries(labels.map(l => [l.id, l]));
  DATA.nodes.forEach(n => {
    const p = POS[n.id], r = radius(n.id), l = labelBy[n.id];
    gHtml += \`<g class="gnode" data-id="\${n.id}">
      <circle cx="\${p.x.toFixed(1)}" cy="\${p.y.toFixed(1)}" r="\${r}" fill="\${typeOf(n.type).color}"></circle>
      \${l ? \`<text x="\${l.x.toFixed(1)}" y="\${l.y.toFixed(1)}" text-anchor="middle">\${esc(l.text)}</text>\` : ""}
      <title>\${esc(n.name)}</title></g>\`;
  });
  gHtml += \`</g>\`;
  svg.innerHTML = gHtml;
  viewport = svg.querySelector("#viewport");

  svg.addEventListener("mouseover", e => {
    const g = e.target.closest(".gnode"); if (!g) return;
    const id = g.dataset.id;
    svg.classList.add("hovering");
    svg.querySelectorAll(".gnode").forEach(el =>
      el.classList.toggle("hl", el.dataset.id === id || adj[id].has(el.dataset.id)));
    svg.querySelectorAll(".gedge").forEach((el) => {
      const ed = DATA.edges[el.dataset.e];
      el.classList.toggle("hl", ed.source === id || ed.target === id);
    });
  });
  svg.addEventListener("mouseout", e => {
    if (e.target.closest(".gnode") && !e.relatedTarget?.closest?.(".gnode")){
      svg.classList.remove("hovering");
      svg.querySelectorAll(".hl").forEach(el => el.classList.remove("hl"));
    }
  });

  function applyView(){ viewport.setAttribute("transform",
    \`translate(\${view.x} \${view.y}) scale(\${view.k}) translate(\${base.tx} \${base.ty}) scale(\${base.s})\`); }
  function refitToPanel(){
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / VB.w, rect.height / VB.h);
    const offX = (rect.width - VB.w * scale) / 2, offY = (rect.height - VB.h * scale) / 2;
    const toVX = px => Math.max(0, Math.min(VB.w, (px - offX) / scale));
    const toVY = px => Math.max(0, Math.min(VB.h, (px - offY) / scale));
    const overlay = window.matchMedia("(min-width: 1101px)").matches;
    let leftLimit = 10, topLimit = 40, rightLimit = VB.w - 10, bottomLimit = VB.h - 40;
    if (overlay){
      const hc = document.querySelector(".hcard").getBoundingClientRect();
      const ex = document.querySelector(".explorer").getBoundingClientRect();
      const ctl = document.querySelector(".bandctl").getBoundingClientRect();
      leftLimit = toVX(16);
      topLimit = toVY(hc.bottom - rect.top + 20);
      rightLimit = toVX(ex.left - rect.left - 20);
      bottomLimit = toVY(ctl.top - rect.top - 14);
      if (rightLimit - leftLimit < 200 || bottomLimit - topLimit < 120){
        topLimit = Math.min(toVY(hc.bottom - rect.top + 20), VB.h - 160);
        bottomLimit = Math.max(bottomLimit, topLimit + 120);
        rightLimit = Math.max(rightLimit, leftLimit + 200);
      }
    }
    const b = viewport.getBBox();
    if (!b.width || !b.height) return;
    const s = Math.min((rightLimit - leftLimit) / b.width, (bottomLimit - topLimit) / b.height, 1);
    base.s = s;
    base.tx = leftLimit + ((rightLimit - leftLimit) - b.width * s) / 2 - b.x * s;
    base.ty = topLimit + ((bottomLimit - topLimit) - b.height * s) / 2 - b.y * s;
    applyView();
  }
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * VB.w;
    const my = (e.clientY - rect.top) / rect.height * VB.h;
    const k2 = Math.min(6, Math.max(0.4, view.k * Math.exp(-e.deltaY * 0.0016)));
    view.x = mx - (mx - view.x) * (k2 / view.k);
    view.y = my - (my - view.y) * (k2 / view.k);
    view.k = k2; applyView();
  }, {passive: false});
  let drag = null;
  svg.addEventListener("pointerdown", e => {
    drag = {x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false,
            node: e.target.closest(".gnode")};
    svg.setPointerCapture(e.pointerId); svg.classList.add("panning");
  });
  svg.addEventListener("pointermove", e => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / rect.width * VB.w;
    const dy = (e.clientY - drag.y) / rect.height * VB.h;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx; view.y = drag.vy + dy; applyView();
  });
  svg.addEventListener("pointerup", e => {
    const clickedNode = drag && !drag.moved ? drag.node : null;
    drag = null; svg.classList.remove("panning");
    if (clickedNode) selectNode(clickedNode.dataset.id, false);
  });
  document.getElementById("zoomReset").addEventListener("click", () => { view.x = 0; view.y = 0; view.k = 1; applyView(); });
  refitToPanel();
  window.addEventListener("resize", refitToPanel);
  document.querySelector("details.conn").addEventListener("toggle", refitToPanel);
}

// legend: only types present, regardless of whether the graph itself renders
document.getElementById("legend").innerHTML = Object.keys(S.nodes_by_type)
  .filter(t => S.nodes_by_type[t] > 0)
  .map(t => \`<span><i style="background:\${typeOf(t).color}"></i>\${esc(typeOf(t).label)}</span>\`).join("");

/* ---------- explorer ---------- */
const exBody = document.getElementById("exBody");
let selectedId = null;
function clearNodeSelection(){
  selectedId = null;
  if (SHOW_GRAPH) svg.querySelectorAll(".gnode.selected").forEach(el => el.classList.remove("selected"));
}
function renderEmpty(){
  exBody.innerHTML = \`<div class="ex-empty">\${SHOW_GRAPH ? "Click a node in the graph — or search above — to inspect an entity here." : "Search above to inspect an entity here."}</div>\`;
}
async function selectNode(id, scroll){
  clearDocSelection();
  exBody.innerHTML = \`<div class="ex-empty">Loading…</div>\`;
  const n = await fetchNodeDetail(id);
  if (!n){ exBody.innerHTML = \`<div class="ex-empty">Not found in this share.</div>\`; return; }
  selectedId = id;
  if (SHOW_GRAPH) svg.querySelectorAll(".gnode").forEach(el => el.classList.toggle("selected", el.dataset.id === id));
  const relRow = (r, dir) =>
    \`<div class="rel">\${dir === "out" ? \`<span class="rname">\${esc(r.relation)} →</span> \` : \`<span class="rname">← \${esc(r.relation)}</span> \`}<a data-goto="\${r.other}">\${esc(trunc(r.other_name, 70))}</a>\${r.asserted_by ? \` <span class="rby">by \${esc(r.asserted_by)}</span>\` : ""}\${(typeof r.context === "string" && r.context.trim()) ? \`<div class="rctx">\${esc(r.context)}</div>\` : ""}</div>\`;
  const deg = n.outgoing.length + n.incoming.length;
  const sourceLine = n.source_ref
    ? (isUrlLike(n.source_ref)
        ? \`<p id="exSource"><a href="\${esc(sourceHref(n.source_ref))}" target="_blank" rel="noopener">Source ↗</a></p>\`
        : \`<p id="exSource" class="exMeta">Source: \${esc(n.source_ref)}</p>\`)
    : "";
  exBody.innerHTML = \`
    <span class="badge" style="color:\${typeOf(n.type).color}; border-color:\${typeOf(n.type).color}">\${esc(typeOf(n.type).label)}</span>
    <p id="exName" title="\${esc(n.name)}">\${esc(trunc(n.name, 80))}</p>
    <div class="exMeta">domain: \${esc(n.domain || S.domains.join(", "))} · \${deg} connection\${deg === 1 ? "" : "s"}</div>
    \${n.description ? \`<p id="exDesc">\${esc(n.description)}</p>\` : ""}
    \${sourceLine}
    \${n.outgoing.length ? \`<div class="rel-h">Outgoing</div>\` + n.outgoing.map(r => relRow(r, "out")).join("") : ""}
    \${n.incoming.length ? \`<div class="rel-h">Incoming</div>\` + n.incoming.map(r => relRow(r, "in")).join("") : ""}
    \${!n.outgoing.length && !n.incoming.length ? \`<div class="rel-h">No connections</div>\` : ""}\`;
  if (scroll){
    const sec = document.getElementById("exploreSec");
    window.scrollTo({top: sec.getBoundingClientRect().top + window.scrollY - 12, behavior: "smooth"});
  }
}
exBody.addEventListener("click", e => {
  const a = e.target.closest("a[data-goto]");
  if (a) selectNode(a.dataset.goto, false);
});
renderEmpty();

/* ---------- search ---------- */
const searchEl = document.getElementById("search");
const resEl = document.getElementById("searchResults");
let searchDebounce;
searchEl.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const q = searchEl.value;
  searchDebounce = setTimeout(async () => {
    const hits = await searchNodes(q);
    resEl.innerHTML = hits.map(n =>
      \`<button data-goto="\${n.id}"><span style="color:\${typeOf(n.type).color}">●</span> \${esc(trunc(n.name, 60))}</button>\`).join("");
  }, HAS_GRAPH ? 0 : 220);
});
resEl.addEventListener("click", e => {
  const b = e.target.closest("button[data-goto]");
  if (b){ selectNode(b.dataset.goto, false); resEl.innerHTML = ""; searchEl.value = ""; }
});
</script>
</body>
</html>
`;
}
