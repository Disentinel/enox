import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import * as service from './service.js';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  CompleteTaskSchema,
  FailTaskSchema,
  HeartbeatSchema,
  BulkCreateSchema,
  ListTasksQuery,
  TaskStatus,
} from './validators.js';

type IdParams = { id: string };

function handleValidationError(res: Response, err: unknown) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.flatten() });
    return true;
  }
  return false;
}

export async function listTasks(req: Request, res: Response) {
  try {
    const filters = ListTasksQuery.parse(req.query);
    const tasks = service.listTasks(filters);
    res.json(tasks);
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function createTask(req: Request, res: Response) {
  try {
    const input = CreateTaskSchema.parse(req.body);
    const task = service.createTask(input);
    res.status(201).json(task);
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function getTask(req: Request<IdParams>, res: Response) {
  const task = service.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
}

export async function updateTask(req: Request<IdParams>, res: Response) {
  try {
    const input = UpdateTaskSchema.parse(req.body);
    const task = service.updateTask(req.params.id, input);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(task);
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function deleteTask(req: Request<IdParams>, res: Response) {
  const deleted = service.deleteTask(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Task not found or not deletable (must be pending, failed, or dead_letter)' });
    return;
  }
  res.status(204).end();
}

export async function getQueueStats(_req: Request, res: Response) {
  const stats = service.getQueueStats();
  res.json(stats);
}

export async function getNextTask(req: Request, res: Response) {
  const workerId = req.query.worker_id as string;
  if (!workerId) {
    res.status(400).json({ error: 'worker_id query parameter required' });
    return;
  }
  const task = service.getNextTask(workerId);
  if (!task) {
    res.status(204).end();
    return;
  }
  res.json(task);
}

export async function completeTask(req: Request<IdParams>, res: Response) {
  try {
    const input = CompleteTaskSchema.parse(req.body);
    const task = service.completeTask(req.params.id, input.worker_id, input.result);
    if (!task) {
      res.status(404).json({ error: 'Task not found or not assigned to this worker' });
      return;
    }
    res.json(task);
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function failTask(req: Request<IdParams>, res: Response) {
  try {
    const input = FailTaskSchema.parse(req.body);
    const task = service.failTask(req.params.id, input.worker_id, input.error);
    if (!task) {
      res.status(404).json({ error: 'Task not found or not assigned to this worker' });
      return;
    }
    res.json(task);
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function heartbeat(req: Request<IdParams>, res: Response) {
  try {
    const input = HeartbeatSchema.parse(req.body);
    const ok = service.heartbeat(req.params.id, input.worker_id, input.progress);
    if (!ok) {
      res.status(404).json({ error: 'Task not found or not assigned to this worker' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function pauseTask(req: Request<IdParams>, res: Response) {
  const task = service.pauseTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found or not in pausable state (must be pending or running)' });
    return;
  }
  res.json(task);
}

export async function resumeTask(req: Request<IdParams>, res: Response) {
  const task = service.resumeTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found or not paused' });
    return;
  }
  res.json(task);
}

export async function bulkCreate(req: Request, res: Response) {
  try {
    const input = BulkCreateSchema.parse(req.body);
    const tasks = service.bulkCreateTasks(input.tasks);
    res.status(201).json(tasks);
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}

export async function clearTasks(req: Request, res: Response) {
  try {
    const status = TaskStatus.parse(req.query.status ?? req.body?.status);
    const count = service.clearTasks(status);
    res.json({ deleted: count });
  } catch (err) {
    if (!handleValidationError(res, err)) throw err;
  }
}
