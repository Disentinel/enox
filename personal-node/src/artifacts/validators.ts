import { z } from 'zod';
import { RELATION_TYPES } from '../types.js';

// An explicit link the caller asserts from the artifact's own node to some
// other entity already in the graph. Distinct from OKF-materialized edges
// (parsed out of a markdown body) — see artifacts/graph.ts for how the two
// are tracked and cleaned up independently.
export const ArtifactLinkSchema = z.object({
  entity_id: z.string().min(1),
  relation: z.enum(RELATION_TYPES).optional().default('describes'),
});

export const CreateArtifactSchema = z.object({
  title: z.string().min(1),
  domain: z.string().min(1),
  content_type: z.string().min(1),
  // Text body. Binary content-types can pass base64 text with encoding: 'base64'.
  // True multipart/form-data upload is not implemented in this phase — see DESIGN note.
  body: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
  filename: z.string().optional(),
  parse_okf: z.boolean().optional().default(false),
  links: z.array(ArtifactLinkSchema).optional().default([]),
});

export const UpdateArtifactSchema = z.object({
  title: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  content_type: z.string().min(1).optional(),
  body: z.string().optional(),
  encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
  filename: z.string().optional(),
  parse_okf: z.boolean().optional(),
  links: z.array(ArtifactLinkSchema).optional(),
});

export const ListArtifactsQuery = z.object({
  domain: z.string().optional(),
  content_type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ArtifactLinkInput = z.infer<typeof ArtifactLinkSchema>;
export type CreateArtifactInput = z.infer<typeof CreateArtifactSchema>;
export type UpdateArtifactInput = z.infer<typeof UpdateArtifactSchema>;
export type ListArtifactsInput = z.infer<typeof ListArtifactsQuery>;
