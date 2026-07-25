import { z } from 'zod';
import { NODE_TYPES, RELATION_TYPES } from '../types.js';

// Practical "is this a URL" check — not chasing RFC 3986. Accepts http(s)://,
// bare doi.org/... or arxiv.org/... (no scheme, as people paste them), and
// falls back to WHATWG URL parsing for anything else with an explicit scheme.
function looksLikeUrl(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  if (/^(doi\.org\/|arxiv\.org\/)/i.test(value)) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export const CreateNodeSchema = z
  .object({
    type: z.enum(NODE_TYPES),
    domain: z.string().min(1).optional().default('cs'),
    name: z.string().min(1),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional().default([]),
    /** URL/DOI/arxiv/doc-ref this entity was sourced from. Optional — absent for hand-authored nodes. Required (and URL-shaped) for type 'paper', see superRefine below. */
    source_ref: z.string().min(1).optional(),
  })
  // Targeted rule, not a general schema/perspective mechanism: "no paper node
  // without a URL" (project decision, 2026-07-24). Only gates NEW paper nodes — the
  // ~10k existing paper nodes without source_ref are grandfathered in
  // (UpdateNodeSchema is untouched, so reads/updates on them keep working).
  .superRefine((data, ctx) => {
    if (data.type !== 'paper') return;
    if (!data.source_ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source_ref'],
        message: 'source_ref is required for type "paper" — every paper node must carry a traceable URL source.',
      });
      return;
    }
    if (!looksLikeUrl(data.source_ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source_ref'],
        message: `source_ref must look like a URL (http://, https://, doi.org/..., arxiv.org/...) for type "paper" — got "${data.source_ref}"`,
      });
    }
  });

export const UpdateNodeSchema = z.object({
  type: z.enum(NODE_TYPES).optional(),
  domain: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
  source_ref: z.string().nullable().optional(),
});

export const CreateAssertionSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum(RELATION_TYPES),
  confidence: z.number().min(0).max(1).optional().default(1.0),
  context: z.string().optional(),
  /**
   * Who/what is asserting this fact — REQUIRED, no default (400 if missing
   * or empty). "No anonymous knowledge": every fact created via the REST API
   * must name its asserter. Convention: humans use a plain identity
   * ("alice"); agents use "agent:<name>". MCP write tools (called by
   * agents, not typed by a human) are a separate, more lenient surface —
   * see mcp/tools.ts, which defaults to config.agentIdentity when omitted.
   */
  asserted_by: z.string().min(1),
  /**
   * Optional depth-of-proof signal. Accepted as real input (not hardcoded to
   * a single literal) but not required — defaults to 0. Whether to retire or
   * develop this field further is an open decision, not resolved here.
   */
  proof_depth: z.number().int().min(0).optional().default(0),
});

export const UpdateAssertionSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  context: z.string().nullable().optional(),
  asserted_by: z.string().min(1).optional(),
  proof_depth: z.number().int().min(0).optional(),
});

export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;
export type UpdateNodeInput = z.infer<typeof UpdateNodeSchema>;
export type CreateAssertionInput = z.infer<typeof CreateAssertionSchema>;
export type UpdateAssertionInput = z.infer<typeof UpdateAssertionSchema>;
