import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import * as service from './service.js';
import { CreatePerspectiveSchema, UpdatePerspectiveSchema, ListPerspectivesQuery } from './validators.js';

export function list(req: Request, res: Response): void {
  try {
    const query = ListPerspectivesQuery.parse(req.query);
    const perspectives = service.listPerspectives(
      query.enabled !== undefined ? { enabled: query.enabled } : undefined,
    );
    res.json(perspectives);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.flatten() });
      return;
    }
    throw err;
  }
}

export function get(req: Request, res: Response): void {
  const perspective = service.getPerspective(req.params.id as string);
  if (!perspective) {
    res.status(404).json({ error: 'Perspective not found' });
    return;
  }
  res.json(perspective);
}

export function create(req: Request, res: Response): void {
  try {
    const input = CreatePerspectiveSchema.parse(req.body);
    const perspective = service.createPerspective(input);
    res.status(201).json(perspective);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.flatten() });
      return;
    }
    if (err instanceof Error && (err as any).code === 'SQLITE_CONSTRAINT') {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
}

export function update(req: Request, res: Response): void {
  try {
    const input = UpdatePerspectiveSchema.parse(req.body);
    const perspective = service.updatePerspective(req.params.id as string, input);
    if (!perspective) {
      res.status(404).json({ error: 'Perspective not found' });
      return;
    }
    res.json(perspective);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.flatten() });
      return;
    }
    throw err;
  }
}

export function remove(req: Request, res: Response): void {
  const ok = service.deletePerspective(req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: 'Perspective not found' });
    return;
  }
  res.status(204).end();
}
