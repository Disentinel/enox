import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifactBody } from './doc-render.js';

test('renderArtifactBody: non-markdown content renders escaped inside a single <pre>', () => {
  const html = renderArtifactBody('<img src=x onerror=alert(1)>', false);
  assert.equal(html, '<pre>&lt;img src=x onerror=alert(1)&gt;</pre>');
});

test('renderArtifactBody: headings, bullet list, bold, inline code, and a link render as expected', () => {
  const src = [
    '# Title',
    '',
    'Some **bold** text with `inline code`.',
    '',
    '- first item',
    '- second item',
    '',
    'See [the docs](https://example.com/docs) for more.',
  ].join('\n');
  const html = renderArtifactBody(src, true);

  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>inline code</code>'));
  assert.ok(html.includes('<ul><li>first item</li><li>second item</li></ul>'));
  assert.ok(html.includes('<a href="https://example.com/docs" target="_blank" rel="noopener">the docs</a>'));
});

test('renderArtifactBody: a fenced code block is escaped verbatim and markdown inside it is not processed', () => {
  const src = ['```', '<script>alert(1)</script>', '**not bold**', '```'].join('\n');
  const html = renderArtifactBody(src, true);
  assert.equal(html, '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n**not bold**</code></pre>');
});

test('renderArtifactBody: XSS — a body containing "</script>" and an onerror image never becomes live markup', () => {
  const hostile = '# Notes\n\nRaw: </script><script>window.__pwned = true;</script> and <img src=x onerror="alert(1)">';
  const html = renderArtifactBody(hostile, true);
  assert.ok(!html.includes('</script><script>'), 'the literal script-breakout sequence must never survive unescaped');
  assert.ok(!html.includes('<img '), 'a raw <img> tag must never be emitted');
  assert.ok(html.includes('&lt;script&gt;'), 'the hostile tag should appear only as escaped entities');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'attribute quotes must be escaped too');
});

test('renderArtifactBody: a javascript: link renders as inert text, never a clickable <a>', () => {
  const html = renderArtifactBody('[click me](javascript:alert(1))', true);
  assert.ok(!html.includes('<a '), 'a javascript: URI must not become a link');
  assert.ok(html.includes('click me (javascript:alert(1))'));
});

test('renderArtifactBody: consecutive "> " lines become one <blockquote>, with inline formatting and escaping still applied', () => {
  const src = ['> First line of a quote.', '> Second line with **bold** and a [link](https://example.com).'].join('\n');
  const html = renderArtifactBody(src, true);
  assert.equal(
    html,
    '<blockquote><p>First line of a quote. Second line with <strong>bold</strong> and a <a href="https://example.com" target="_blank" rel="noopener">link</a>.</p></blockquote>',
  );
});

test('renderArtifactBody: a blockquote containing "</script>" is escaped, not emitted as live markup', () => {
  const html = renderArtifactBody('> </script><script>alert(1)</script>', true);
  assert.ok(html.startsWith('<blockquote>'));
  assert.ok(!html.includes('</script><script>alert'), 'the literal script-breakout sequence must never survive unescaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderArtifactBody: a heading/list/paragraph containing markdown-special characters round-trips as plain escaped text when not valid syntax', () => {
  const html = renderArtifactBody('Price: 5 > 3 & 2 < 4 "quoted"', true);
  assert.equal(html, '<p>Price: 5 &gt; 3 &amp; 2 &lt; 4 &quot;quoted&quot;</p>');
});
