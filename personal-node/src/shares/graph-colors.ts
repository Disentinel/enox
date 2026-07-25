// Type -> color mapping for the share receipt's graph visualization.
//
// The approved design (claude.ai/design mock, share-receipt.html) hand-picked
// 4 colors for the 4 node types it was shown (concept/decision/belief/
// rejected_alternative) in its own bespoke dark-tech visual language — NOT the
// dataviz skill's default categorical palette. Real Enox graphs have ~24
// distinct NODE_TYPES (see src/types.ts), so this module extends that same
// language to 5 more slots by eye (matching the existing colors' saturation/
// lightness character in both light and dark), while leaving the original 4
// colors byte-for-byte unchanged — those were reviewed and approved,
// so this integration must not shift them even slightly.
//
// The mapping is a fixed, global type -> CSS-variable assignment (never
// reordered per share), so a given node type always renders the same color
// everywhere. Anything not explicitly listed folds to --c-other rather than
// generating a new color.

export interface TypeMeta {
  label: string;
  cssVar: string;
}

// CSS custom properties, dark values first (the mock's default/primary theme)
// then the `prefers-color-scheme: light` override it already declares. The
// first 4 are copied verbatim from the mock; the other 5 are new, chosen to
// match their character (dark: light/vivid pastel on near-black; light:
// darker/more saturated on white) rather than run through the dataviz skill's
// validator — this is a different, already human-approved bespoke palette,
// not an instance of that skill's reference palette, so eyeballed consistency
// with the existing 4 is the right bar here, not re-deriving from scratch.
const VARS: Array<{ name: string; dark: string; light: string }> = [
  { name: '--c-concept', dark: '#3fd6ee', light: '#0f93ac' },   // unchanged from the mock
  { name: '--c-decision', dark: '#ee5fd2', light: '#bb2f9e' },  // unchanged from the mock
  { name: '--c-belief', dark: '#9d86ff', light: '#6c50e0' },    // unchanged from the mock
  { name: '--c-rejected', dark: '#75858f', light: '#68787f' },  // unchanged from the mock
  { name: '--c-blue', dark: '#6fa3f5', light: '#3568c9' },      // new: person/provenance cluster
  { name: '--c-amber', dark: '#f5b95f', light: '#b8760f' },     // new: temporal cluster
  { name: '--c-green', dark: '#6fe0a5', light: '#1f9c62' },     // new: work/task cluster
  { name: '--c-coral', dark: '#f28080', light: '#c23f3f' },     // new: research cluster
  { name: '--c-other', dark: '#94a3ad', light: '#7d8f9c' },     // new: fallback for anything unmapped
];

// type -> {label, cssVar}. The 4 types the mock already handles keep their
// exact original var + a matching display label ("rejected alt" is the mock's
// own shorthand, kept verbatim); everything else buckets into one of the 5 new
// vars by semantic cluster, or --c-other if it doesn't fit any cluster.
const TYPE_META: Record<string, TypeMeta> = {
  concept: { label: 'concept', cssVar: '--c-concept' },
  pattern: { label: 'pattern', cssVar: '--c-concept' },
  component: { label: 'component', cssVar: '--c-concept' },

  decision: { label: 'decision', cssVar: '--c-decision' },

  opinion: { label: 'opinion', cssVar: '--c-belief' },
  preference: { label: 'preference', cssVar: '--c-belief' },
  value: { label: 'value', cssVar: '--c-belief' },
  belief: { label: 'belief', cssVar: '--c-belief' },

  rejected_alternative: { label: 'rejected alt', cssVar: '--c-rejected' },

  person: { label: 'person', cssVar: '--c-blue' },
  channel: { label: 'channel', cssVar: '--c-blue' },
  post: { label: 'post', cssVar: '--c-blue' },
  linkedin_person: { label: 'linkedin person', cssVar: '--c-blue' },
  linkedin_company: { label: 'linkedin company', cssVar: '--c-blue' },

  date: { label: 'date', cssVar: '--c-amber' },
  event: { label: 'event', cssVar: '--c-amber' },

  effort: { label: 'effort', cssVar: '--c-green' },
  task: { label: 'task', cssVar: '--c-green' },
  session: { label: 'session', cssVar: '--c-green' },
  intent: { label: 'intent', cssVar: '--c-green' },

  paper: { label: 'paper', cssVar: '--c-coral' },
  npm_package: { label: 'npm package', cssVar: '--c-coral' },
  npm_symbol: { label: 'npm symbol', cssVar: '--c-coral' },
  linkedin_skill: { label: 'linkedin skill', cssVar: '--c-coral' },
  linkedin_location: { label: 'linkedin location', cssVar: '--c-coral' },
};

const OTHER_META: TypeMeta = { label: 'other', cssVar: '--c-other' };

export function typeMeta(type: string): TypeMeta {
  return TYPE_META[type] ?? { label: type.replace(/_/g, ' '), cssVar: OTHER_META.cssVar };
}

// Builds the `TYPE` JS object literal the page script indexes by node type —
// only for types actually present in this share (matches the design's own
// "legend only shows present types" behavior; keeps the embedded page lean).
export function buildTypeMapLiteral(typesPresent: Iterable<string>): Record<string, { label: string; color: string }> {
  const out: Record<string, { label: string; color: string }> = {};
  for (const t of typesPresent) {
    const meta = typeMeta(t);
    out[t] = { label: meta.label, color: `var(${meta.cssVar})` };
  }
  return out;
}

// CSS custom-property declarations — dark is the mock's default (declared on
// :root with no media query), overridden to light via the mock's existing
// `@media (prefers-color-scheme: light)` block. Returns just the property
// list (no selector wrapper) so the caller can splice it into the mock's
// existing :root blocks without restructuring them.
export function cssVarsBlock(mode: 'dark' | 'light'): string {
  return VARS.map(v => `  ${v.name}:${v[mode]};`).join('\n');
}
