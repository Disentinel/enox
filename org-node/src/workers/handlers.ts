import type { Request, Response } from 'express';
import * as service from './service.js';

export function register(req: Request, res: Response): void {
  const { name, capabilities } = req.body;

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required and must be a string' });
    return;
  }

  if (!Array.isArray(capabilities) || !capabilities.every((c: unknown) => typeof c === 'string')) {
    res.status(400).json({ error: 'capabilities must be an array of strings' });
    return;
  }

  const result = service.registerWorker({
    name,
    capabilities,
    ip_address: req.ip,
    user_agent: req.get('user-agent'),
  });

  res.status(201).json(result);
}

export function list(_req: Request, res: Response): void {
  const workers = service.listWorkers();
  res.json(workers);
}

export function get(req: Request, res: Response): void {
  const worker = service.getWorker(req.params.id as string);
  if (!worker) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }
  res.json(worker);
}

export function heartbeat(req: Request, res: Response): void {
  const ok = service.heartbeat(req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }
  res.status(204).end();
}

export function deregister(req: Request, res: Response): void {
  const ok = service.deregisterWorker(req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: 'Worker not found' });
    return;
  }
  res.status(204).end();
}
