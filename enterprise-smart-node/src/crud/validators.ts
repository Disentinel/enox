import { z } from 'zod';

// Schemaless: node `type` and edge `relation` are arbitrary non-empty strings.
// No fixed enum is enforced — tenants bring their own ontology.

export const CreateNodeSchema = z.object({
  type: z.string().min(1),
  domain: z.string().min(1).optional().default('cs'),
  name: z.string().min(1),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional().default([]),
});

export const UpdateNodeSchema = z.object({
  type: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
});

export const CreateAssertionSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.string().min(1),
  confidence: z.number().min(0).max(1).optional().default(1.0),
  context: z.string().optional(),
});

export const UpdateAssertionSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  context: z.string().nullable().optional(),
});

export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;
export type UpdateNodeInput = z.infer<typeof UpdateNodeSchema>;
export type CreateAssertionInput = z.infer<typeof CreateAssertionSchema>;
export type UpdateAssertionInput = z.infer<typeof UpdateAssertionSchema>;
