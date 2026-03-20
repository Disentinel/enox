export const NODE_TYPES = [
  'concept',
  'decision',
  'component',
  'pattern',
  'rejected_alternative',
  // temporal
  'date',
  'event',
  // opinions
  'opinion',
  'preference',
  'value',
  'belief',
  // provenance
  'channel',
  'post',
  'person',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const RELATION_TYPES = [
  // knowledge
  'depends_on',
  'supersedes',
  'implements',
  'contradicts',
  'part_of',
  'extends',
  'enables',
  'isomorphic_to',
  // temporal
  'decided_on',
  'discussed_on',
  'changed_on',
  'created_on',
  'preceded_by',
  'triggered_by',
  // opinions
  'prefers',
  'distrusts',
  'values',
  'rejects',
  'believes',
  'frustrated_by',
  // provenance
  'published_in',
  'authored_by',
  'mentioned_in',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

// URI prefix is configured per-node via NODE_URI_PREFIX env var.
// Re-exported from config for backward compat — modules should import from config.ts
// Default: enox://enox.dev/personal/vadim_r
export const ENTITY_URI_PREFIX = process.env.NODE_URI_PREFIX ?? 'enox://enox.dev/personal/vadim_r';

export interface Entity {
  id: string;
  type: NodeType;
  domain: string;
  name: string;
  description: string | null;
  aliases: string[];
  created_at: string;
  updated_at: string;
}

export interface Assertion {
  fact_id: string;
  source: string;
  target: string;
  relation: RelationType;
  asserted_by: string;
  confidence: number;
  proof_depth: number | null;
  context: string | null;
  created_at: string;
  updated_at: string;
}
