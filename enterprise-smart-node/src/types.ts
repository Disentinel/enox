// Schemaless data model: node types and relation types are arbitrary free-form
// strings. The graph does NOT enforce a fixed vocabulary — any tenant can use
// whatever ontology fits their domain. The lists below are kept only as
// non-binding SUGGESTIONS surfaced in tool/API descriptions; nothing validates
// against them. Add to them freely or ignore them entirely.

export type NodeType = string;
export type RelationType = string;

/** Suggested node types (non-binding — type is a free string). */
export const SUGGESTED_NODE_TYPES = [
  'concept',
  'decision',
  'component',
  'pattern',
  'rejected_alternative',
  'date',
  'event',
  'opinion',
  'preference',
  'value',
  'belief',
  'channel',
  'post',
  'person',
  'effort',
  'task',
  'session',
  'intent',
  'paper',
] as const;

/** Suggested relation types (non-binding — relation is a free string). */
export const SUGGESTED_RELATION_TYPES = [
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
  // tasks & intents
  'task_of',
  'blocks',
  'produced_by',
  'references',
  'about',              // task/intent → concept (what it's about)
  'decomposes_into',    // intent → task (intent broken into tasks)
  // npm registry
  'exports',     // npm_package → npm_symbol
  // people & organizations
  'works_at',        // person → company (current)
  'worked_at',       // person → company (past)
  'has_skill',       // person → skill
  'endorsed_for',    // person → skill (with endorsement signal)
  'studied_at',      // person → institution
  'located_in',      // person/company → location
  'requires_skill',  // company → skill (from job postings)
  'similar_to',      // company → company (derived)
  // academic / research graph
  'introduces',       // paper → concept
  'outperforms',      // paper/concept → paper/concept
  'requires',         // concept → concept
  'fails_on',         // concept → concept
  'supports',         // paper → concept
  'applies_to',       // concept → concept
  'is_based_on',      // paper → paper/concept
  'uses',             // paper/concept → concept
  'foundational_for', // concept → concept
  'equivalent_to',    // concept → concept
  'uses_method',      // paper → concept
  'contributes_to',   // paper → concept
  'refutes',          // paper → paper/concept
  'related_to',       // concept → concept
  'surveys',          // paper → concept
  'formalizes',       // paper → concept
  'instance_of',      // concept → concept
  'builds_on',        // paper → paper
  'cites',            // paper → paper
  'influences',       // paper/concept → paper/concept
  'motivates',        // concept → concept
  'empirically_validates', // paper → concept
  'evaluates',        // paper → concept
  'evaluated_on',     // paper → concept
  'alternative_to',   // concept → concept
  'subclass_of',      // concept → concept
  'technique_for',    // concept → concept
  'applies',          // concept → concept
  'contemporaneous_with', // paper → paper
  'competes_with',    // concept → concept
  'implemented_by',   // concept → paper
  'application_of',   // concept → concept
  'critiques',        // paper → paper
  'proposes_solution', // paper → concept
  'independent_parallel', // paper → paper
  'parallel',         // paper → paper
  'uses_dataset',     // paper → concept
  'connects',         // concept → concept
  'generalizes',      // concept → concept
  'simplifies',       // concept → concept
  'constrains',       // concept → concept
  'used_by',          // concept → concept
  'explains_mechanism', // paper → concept
  'addresses',        // paper → concept
  'operationalizes',  // paper → concept
  'challenges',       // paper → concept
] as const;

// URI prefix is configured per-node via NODE_URI_PREFIX env var.
// Re-exported from config for backward compat — modules should import from config.ts
// Neutral default; override per deployment/tenant via NODE_URI_PREFIX.
export const ENTITY_URI_PREFIX = process.env.NODE_URI_PREFIX ?? 'enox://local/default';

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
