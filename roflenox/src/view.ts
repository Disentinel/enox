// The page of a view (r_subscribe): static, the same for every view. It reads
// its owner and name from its own path — /view/<owner>/<name>, after a prefix
// of non-empty segments a reverse proxy may add — and opens the URL it builds
// from its own origin and them (never its path as given: a path starting //
// names another host) as an event stream
// with the reader's bearer token (#token=…) or a view link a grantee minted
// with its own key (#link=…, src/viewlink.ts) — from the fragment, which the
// browser never sends, or typed into the page; held in the page's memory
// only and sent in the Authorization header — and shows the rows of the view's literal lighting up as they come
// and going out as they go. Plain HTML and JS: no build step.
import * as crypto from 'node:crypto';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>FKTS view</title>
<style>
:root { --bg:#fff; --fg:#1d1d1f; --mute:#6e6e73; --line:#e5e5ea; --on:#d8f5dd; --off:#fbe0e0; }
@media (prefers-color-scheme: dark) { :root { --bg:#161617; --fg:#f5f5f7; --mute:#98989d; --line:#2c2c2e; --on:#1f4d2a; --off:#5a2323; } }
body { background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; margin:0; padding:16px; }
h1 { font-size:18px; margin:0 0 4px; } #lit { font-family:ui-monospace, monospace; color:var(--mute); }
#status { color:var(--mute); margin:8px 0 12px; font-size:12px; word-break:break-all; }
table { border-collapse:collapse; width:100%; } th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); font-family:ui-monospace, monospace; font-size:13px; }
tr.on { background:var(--on); transition:background 2s; } tr.off { background:var(--off); opacity:.5; } tr.calm { background:transparent; transition:background 2s; }
form { margin:12px 0; display:none; } input { font:inherit; padding:4px; width:22em; max-width:100%; }
</style></head><body>
<h1 id="title"></h1><div id="lit"></div><div id="status">connecting…</div>
<form id="auth"><input id="tok" type="password" placeholder="operator token or view link"> <button>open</button></form>
<table><thead id="head"></thead><tbody id="rows"></tbody></table>
<script>
const $ = (id) => document.getElementById(id);
const segs = location.pathname.split('/');
const at = segs.length - 3;
const good = segs[0] === '' && at >= 1 && segs[at] === 'view' && segs.slice(1).every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes('\\\\'));
const target = good ? new URL(location.origin + segs.slice(0, at).join('/') + '/view/' + segs[at + 1] + '/' + segs[at + 2]) : null;
const here = target !== null && target.origin === location.origin;
const word = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
$('title').textContent = here ? word(segs[at + 2]) + ' — ' + word(segs[at + 1]) : 'not a view';
const given = new URLSearchParams(location.hash.slice(1));
let token = given.get('token') || given.get('link');
if (location.hash && here) history.replaceState(null, '', target.pathname);
const rows = new Map();
const key = (r) => JSON.stringify([r.identity, r.cells]);
function tr(r) { const t = document.createElement('tr'); for (const c of [r.identity, ...r.cells]) { const d = document.createElement('td'); d.textContent = String(c); t.appendChild(d); } return t; }
function light(t) { t.className = 'on'; setTimeout(() => { t.className = 'calm'; }, 50); }
function frame(f) {
  $('status').textContent = f.kind + ' at ' + (f.head || '–') + (f.cause ? ' · cause ' + f.cause : '') + (f.by ? ' · by ' + f.by : '');
  if (f.kind === 'refused') { $('status').textContent = 'refused: ' + f.message; return; }
  if (f.kind === 'full') {
    $('head').innerHTML = ''; const h = document.createElement('tr');
    for (const v of ['book', ...(f.vars || [])]) { const th = document.createElement('th'); th.textContent = v; h.appendChild(th); }
    $('head').appendChild(h);
    const now = new Map(f.rows.map((r) => [key(r), r]));
    for (const [k, t] of rows) if (!now.has(k)) { t.remove(); rows.delete(k); }
    for (const [k, r] of now) if (!rows.has(k)) { const t = tr(r); $('rows').appendChild(t); rows.set(k, t); }
    return;
  }
  for (const r of f.removed || []) { const t = rows.get(key(r)); if (!t) continue; rows.delete(key(r)); t.className = 'off'; setTimeout(() => t.remove(), 2500); }
  for (const r of f.added || []) { if (rows.has(key(r))) continue; const t = tr(r); $('rows').appendChild(t); rows.set(key(r), t); light(t); }
}
async function open() {
  if (!here) { $('status').textContent = 'this page is served only at /view/<owner>/<name> of its own node'; return; }
  const res = await fetch(target.href, { headers: { accept: 'text/event-stream', ...(token ? { authorization: (token.includes('.') ? 'RoflenoxView ' : 'Bearer ') + token } : {}) } });
  if (!res.ok) { const b = await res.json().catch(() => ({})); $('status').textContent = res.status + ' ' + (b.message || b.error || ''); $('auth').style.display = 'block'; return; }
  $('auth').style.display = 'none';
  const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\\n\\n')) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = ev.split('\\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\\n');
      if (data) frame(JSON.parse(data));
    }
  }
  $('status').textContent += ' · closed; reconnecting'; setTimeout(open, 2000);
}
$('auth').addEventListener('submit', (e) => { e.preventDefault(); token = $('tok').value; open(); });
open();
</script></body></html>
`;

const inner = (tag: string) => PAGE.slice(PAGE.indexOf(`<${tag}>`) + tag.length + 2, PAGE.indexOf(`</${tag}>`));
const hash = (tag: string) => `'sha256-${crypto.createHash('sha256').update(inner(tag)).digest('base64')}'`;

export const VIEW_PAGE = PAGE;
/** The page's own headers: it runs only its own script and style, reads only
 *  its own origin, posts no form, and is framed by nobody. */
export const VIEW_HEADERS = {
  'content-security-policy': `default-src 'none'; script-src ${hash('script')}; style-src ${hash('style')}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
};
