import { z } from 'zod';

export const CreateShareSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  domains: z.array(z.string().min(1)).min(1),
  ttl_days: z.number().int().min(1).max(3650).optional(),
});

export type CreateShareInput = z.infer<typeof CreateShareSchema>;
