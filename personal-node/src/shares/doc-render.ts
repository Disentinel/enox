// Minimal, dependency-free Markdown -> HTML renderer for artifact bodies shown
// in the share receipt's Documents panel (skill files, notes, etc). Exported
// as a plain function so it can be:
//   (a) unit-tested directly in Node (doc-render.test.ts), verifying the
//       handful of markdown constructs it supports and — more importantly —
//       that it never lets artifact content become live markup, and
//   (b) inlined into the receipt page's client <script> via .toString() in
//       landing-html.ts, so the exact code exercised by the unit tests is
//       what actually runs in the browser, not a hand-copied duplicate.
// Consequence of (b): this function must be fully self-contained — no
// references to anything outside its own body (no closures over module-level
// helpers, no imports) — because .toString() only captures the function's own
// source text, not the module around it.
//
// Supports: #..###### headings, - / * bullet lists, > blockquotes, ``` code
// fences, `inline code`, **bold**, [text](url) links, and paragraphs. Every line of
// artifact content is escaped (esc) before any trusted tag is wrapped around
// it, so a hostile artifact body (e.g. containing "</script>" or
// "<img onerror=...>") can never become live HTML — it can only ever appear
// as escaped text inside the tags this function itself generates.
export function renderArtifactBody(src: string, isMarkdown: boolean): string {
  function esc(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  }

  if (!isMarkdown) {
    return '<pre>' + esc(String(src)) + '</pre>';
  }

  // Inline formatting runs on already-escaped text: esc() only ever touches
  // & < > " ', so markdown syntax characters ([ ] ( ) ` *) survive it
  // untouched and these regexes still match — but any literal HTML the
  // artifact body contained is by this point inert entities, so wrapping it
  // in trusted tags below can't reintroduce it as markup.
  function inline(s: string): string {
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
      // Only allow http(s) and same-origin-ish (relative/hash) targets as a
      // real link — a javascript: or data: URI renders as inert plain text
      // instead, since esc() alone doesn't neutralize a dangerous scheme.
      const isSafeScheme = /^(https?:\/\/|\/|#)/i.test(url);
      return isSafeScheme ? `<a href="${url}" target="_blank" rel="noopener">${text}</a>` : `${text} (${url})`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let para: string[] = [];
  let list: string[] | null = null;
  let quote: string[] | null = null;

  function flushPara(): void {
    if (para.length) { html += '<p>' + para.join(' ') + '</p>'; para = []; }
  }
  function flushList(): void {
    if (list) { html += '<ul>' + list.map(li => '<li>' + li + '</li>').join('') + '</ul>'; list = null; }
  }
  function flushQuote(): void {
    if (quote) { html += '<blockquote><p>' + quote.join(' ') + '</p></blockquote>'; quote = null; }
  }

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    if (/^```/.test(raw)) {
      flushPara(); flushList(); flushQuote();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence (or run off the end if the fence was never closed)
      html += '<pre><code>' + code.map(esc).join('\n') + '</code></pre>';
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      flushPara(); flushList(); flushQuote();
      const level = heading[1].length;
      html += `<h${level}>${inline(esc(heading[2]))}</h${level}>`;
      i++; continue;
    }

    const item = /^[-*]\s+(.*)$/.exec(raw);
    if (item) {
      flushPara(); flushQuote();
      if (!list) list = [];
      list.push(inline(esc(item[1])));
      i++; continue;
    }

    const quoteLine = /^>\s?(.*)$/.exec(raw);
    if (quoteLine) {
      flushPara(); flushList();
      if (!quote) quote = [];
      quote.push(inline(esc(quoteLine[1])));
      i++; continue;
    }

    if (raw.trim() === '') {
      flushPara(); flushList(); flushQuote();
      i++; continue;
    }

    flushList(); flushQuote();
    para.push(inline(esc(raw)));
    i++;
  }
  flushPara(); flushList(); flushQuote();
  return html;
}
