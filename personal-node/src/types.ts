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
  // openloops
  'effort',
  'task',
  'session',
  'intent',
  // npm registry
  'npm_package',
  'npm_symbol',
  // linkedin professional graph
  'linkedin_person',
  'linkedin_company',
  'linkedin_skill',
  'linkedin_location',
  // academic / research
  'paper',
  // artifacts (arbitrary content-type blobs linked into the graph — see src/artifacts/)
  'artifact',
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
  // openloops
  'task_of',
  'blocks',
  'produced_by',
  'references',
  'about',              // task/intent → concept (what it's about)
  'decomposes_into',    // intent → task (intent broken into tasks)
  // npm registry
  'exports',     // npm_package → npm_symbol
  // linkedin professional graph
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
  // artifacts
  'describes',        // artifact → entity (artifact is about/documents this entity)
  'primary_doc',      // artifact → entity (this artifact IS the long-form record of the entity, 1:1 by convention — not enforced server-side)
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

// URI prefix is configured per-node via NODE_URI_PREFIX env var.
// Re-exported from config for backward compat — modules should import from config.ts
// Default: enox://example.org/graph/main
export const ENTITY_URI_PREFIX = process.env.NODE_URI_PREFIX ?? 'enox://example.org/graph/main';

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
