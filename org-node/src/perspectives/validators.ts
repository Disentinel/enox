import { z } from 'zod';

export const CreatePerspectiveSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'ID must be lowercase slug'),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  system_prompt: z.string().min(10),
  node_types: z.array(z.string()).min(1),
  relation_types: z.array(z.string()).min(1),
  domains: z.array(z.string()).optional(),
  chunk_size: z.number().int().min(500).max(16000).default(4000),
  chunk_overlap: z.number().int().min(0).max(2000).default(500),
  llm_model: z.string().default('sonnet'),
  temperature: z.number().min(0).max(1).default(0),
  enabled: z.boolean().default(true),
});

export const UpdatePerspectiveSchema = CreatePerspectiveSchema.partial().omit({ id: true });

export const ListPerspectivesQuery = z.object({
  enabled: z.coerce.boolean().optional(),
});

export type CreatePerspectiveInput = z.infer<typeof CreatePerspectiveSchema>;
export type UpdatePerspectiveInput = z.infer<typeof UpdatePerspectiveSchema>;
