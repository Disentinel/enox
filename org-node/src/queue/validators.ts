import { z } from 'zod';

export const TaskStatus = z.enum(['pending', 'running', 'completed', 'failed', 'paused', 'dead_letter']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskType = z.enum(['crawl', 'extract', 'canonicalize', 'dedup', 'embed', 'review', 'fetch_papers', 'custom']);
export type TaskType = z.infer<typeof TaskType>;

export const CreateTaskSchema = z.object({
  type: TaskType,
  source_url: z.string().optional(),
  perspective: z.string().optional(),
  priority: z.number().int().default(0),
  config_json: z.record(z.unknown()).optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
});

export const UpdateTaskSchema = z.object({
  status: TaskStatus.optional(),
  priority: z.number().int().optional(),
  config_json: z.record(z.unknown()).optional(),
});

export const CompleteTaskSchema = z.object({
  worker_id: z.string(),
  result: z.record(z.unknown()),
});

export const FailTaskSchema = z.object({
  worker_id: z.string(),
  error: z.string(),
});

export const HeartbeatSchema = z.object({
  worker_id: z.string(),
  progress: z.record(z.unknown()).optional(),
});

export const BulkCreateSchema = z.object({
  tasks: z.array(CreateTaskSchema).min(1).max(500),
});

export const ListTasksQuery = z.object({
  status: TaskStatus.optional(),
  type: TaskType.optional(),
  assigned_to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
