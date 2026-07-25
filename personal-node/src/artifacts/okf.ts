// OKF markdown parsing for artifact ingestion — ported from the research
// prototype at enox/okf-lab/lib/format.js + compile.js (round-trip verified
// there), NOT reimplemented from scratch per the phase-1 brief. Only the
// parse direction is needed here (markdown -> edges); the encode/export
// direction (lib/format.js's formatBullet etc.) stays in okf-lab, unused by
// smart-node.
//
// Deviation from okf-lab's page model: a wiki page there always has
// frontmatter with an authoritative `id` (compile.js throws if missing) and
// Relations bullets are edges FROM that frontmatter id. An artifact is not
// necessarily a full wiki page — frontmatter is optional here, and even when
// present its `id`/`domain`/`type` fields are never trusted as an identity
// claim (arbitrary text in an uploaded body). The artifact's own entity_id
// (assigned by the API, see artifacts/graph.ts) is always the edge source;
// callers pass it plus the artifact's `domain` in as currentDomain for
// resolving same-domain [[slug]] wikilinks.
import { ENTITY_URI_PREFIX } from '../types.js';

function idFor(domain: string, slug: string): string {
  return `${ENTITY_URI_PREFIX}/${domain}/${slug}`;
}

function resolveTargetLink(targetLink: string, currentDomain: string): string {
  const hasSlash = targetLink.includes('/');
  if (!hasSlash) return idFor(currentDomain, targetLink);
  const domain = targetLink.slice(0, targetLink.lastIndexOf('/'));
  const slug = targetLink.split('/').pop()!;
  return idFor(domain, slug);
}

// --- context escaping (light inline path only, see format.js) --------------
function decodeContext(encoded: string): string {
  return (encoded || '').replace(/\\n/g, '\n');
}

// --- Relations bullet --------------------------------------------------------
// - relation [[target-slug]] ([→](target-slug.md)) {confidence: 0.9, by: alice} — context
const BULLET_RE =
  /^- (\S+) \[\[([a-zA-Z0-9_./-]+)\]\](?: \(\[→\]\(([^)]*)\)\))? \{confidence: ([0-9]*\.?[0-9]+)(?:, by: ([^}]*))?\}(?: — (.*))?$/;

interface ParsedBullet {
  relation: string;
  target: string;
  confidence: number;
  assertedBy: string | null;
  context: string;
}

function parseBullet(line: string, currentDomain: string): ParsedBullet | null {
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  const [, relation, targetLink, , confidenceStr, assertedBy, contextEncoded] = m;
  return {
    relation,
    target: resolveTargetLink(targetLink, currentDomain),
    confidence: parseFloat(confidenceStr),
    assertedBy: assertedBy || null,
    context: decodeContext(contextEncoded || ''),
  };
}

// --- subsections (heavy-context "### relation → target" blocks) ------------
const SUBSECTION_HEADING_RE = /^### (\S+) → (\S+)$/;
const SUBSECTION_HEADING_START_RE = /^### .+$/m;

function canonEdgeKey(source: string, relation: string, target: string): string {
  return `${source}|${relation}|${target}`;
}

function parseSubsections(text: string, currentDomain: string, sourceId: string): Map<string, string> {
  const map = new Map<string, string>();
  const trimmed = (text || '').trim();
  if (!trimmed) return map;
  const chunks = trimmed.split(/\n(?=### )/);
  for (const chunk of chunks) {
    const nlIdx = chunk.indexOf('\n');
    const headingLine = nlIdx === -1 ? chunk : chunk.slice(0, nlIdx);
    const rest = nlIdx === -1 ? '' : chunk.slice(nlIdx + 1);
    const hm = SUBSECTION_HEADING_RE.exec(headingLine.trim());
    if (!hm) throw new Error(`unparseable OKF subsection heading: ${JSON.stringify(headingLine)}`);
    const [, relation, targetLink] = hm;
    const target = resolveTargetLink(targetLink, currentDomain);
    map.set(canonEdgeKey(sourceId, relation, target), rest.trim());
  }
  return map;
}

// --- Citations section -------------------------------------------------------
const CITATIONS_HEADING_LINE = '## Citations';
const CITATIONS_HEADING_START_RE = /^## Citations$/m;
const CITE_LINE_RE = /^(\d+)\.\s*<a id="cite-\d+"><\/a>(.*)$/;

function parseCitationsSection(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const trimmed = (text || '').trim();
  if (!trimmed) return map;
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue;
    const m = CITE_LINE_RE.exec(line);
    if (!m) throw new Error(`unparseable OKF Citations line: ${JSON.stringify(line)}`);
    const [, num, url] = m;
    map.set(Number(num), url.trim());
  }
  return map;
}

function reverseCitations(text: string, citeMap: Map<number, string>): string {
  if (!text) return text;
  return text.replace(/\[(\d+)\]\(#cite-(\d+)\)/g, (match, n1, n2) => {
    if (n1 !== n2) return match;
    const url = citeMap.get(Number(n1));
    return url !== undefined ? url : match;
  });
}

// --- frontmatter ------------------------------------------------------------
// Unlike compile.js (which requires frontmatter on every wiki page), an
// artifact's body may or may not start with a `---\n...\n---\n` block. When
// absent, the whole input is body. Values inside are never read (see file
// header) — this only exists to keep frontmatter out of the description/edge
// parsing below.
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n')) return raw;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return raw; // unterminated -- treat conservatively as no frontmatter
  return raw.slice(end + 5);
}

const RELATIONS_HEADING_LINE = '## Relations';

function splitRelationsBlock(afterRelations: string): { bulletsText: string; subsectionsText: string; citationsText: string } {
  const subMatch = SUBSECTION_HEADING_START_RE.exec(afterRelations);
  const citeMatch = CITATIONS_HEADING_START_RE.exec(afterRelations);
  const citeHeadingIdx = citeMatch ? citeMatch.index : -1;

  let bulletsEnd = afterRelations.length;
  if (subMatch) bulletsEnd = Math.min(bulletsEnd, subMatch.index);
  if (citeHeadingIdx !== -1) bulletsEnd = Math.min(bulletsEnd, citeHeadingIdx);
  const bulletsText = afterRelations.slice(0, bulletsEnd).trim();

  let subsectionsText = '';
  if (subMatch) {
    const subEnd = citeHeadingIdx !== -1 ? citeHeadingIdx : afterRelations.length;
    subsectionsText = afterRelations.slice(subMatch.index, subEnd).trim();
  }

  const citationsText = citeHeadingIdx !== -1
    ? afterRelations.slice(citeHeadingIdx + CITATIONS_HEADING_LINE.length).trim()
    : '';

  return { bulletsText, subsectionsText, citationsText };
}

export interface ParsedOkfEdge {
  relation: string;
  target: string;
  confidence: number;
  assertedBy: string | null;
  context: string;
}

// Parses OKF Relations bullets (+ heavy-context subsections + Citations
// reversal) out of a markdown artifact body. sourceId is the artifact's own
// entity_id — every parsed edge is FROM sourceId, never derived from
// frontmatter. Throws on a malformed bullet/subsection/citations line (same
// strictness as compile.js) since a caller that opted into parse_okf handed
// us structured markup they expect to be taken literally.
export function parseOkfRelations(rawBody: string, currentDomain: string, sourceId: string): ParsedOkfEdge[] {
  const body = stripFrontmatter(rawBody);
  const headingIdx = body.indexOf(RELATIONS_HEADING_LINE);
  if (headingIdx === -1) return [];

  const afterRelations = body.slice(headingIdx + RELATIONS_HEADING_LINE.length);
  const { bulletsText, subsectionsText, citationsText } = splitRelationsBlock(afterRelations);

  const citeMap = parseCitationsSection(citationsText);
  const reverse = (text: string) => reverseCitations(text, citeMap);

  const bulletParsed: ParsedBullet[] = [];
  if (bulletsText && bulletsText !== '_(no outgoing relations)_') {
    for (const line of bulletsText.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseBullet(line, currentDomain);
      if (!parsed) throw new Error(`unparseable OKF Relations bullet: ${JSON.stringify(line)}`);
      bulletParsed.push(parsed);
    }
  }

  const subsectionMap = parseSubsections(subsectionsText, currentDomain, sourceId);

  return bulletParsed.map((p) => {
    const key = canonEdgeKey(sourceId, p.relation, p.target);
    const context = subsectionMap.has(key) ? reverse(subsectionMap.get(key)!) : reverse(p.context);
    return {
      relation: p.relation,
      target: p.target,
      confidence: p.confidence,
      assertedBy: p.assertedBy,
      context,
    };
  });
}
