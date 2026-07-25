import type { Request, Response } from 'express';
import * as service from './service.js';

export async function current(_req: Request, res: Response): Promise<void> {
  const metrics = await service.getCurrentMetrics();
  res.json(metrics);
}

export async function history(req: Request, res: Response): Promise<void> {
  const { from, to, limit } = req.query as { from?: string; to?: string; limit?: string };
  const data = service.getMetricHistory(from, to, limit ? parseInt(limit, 10) : undefined);
  res.json(data);
}

export async function extractions(_req: Request, res: Response): Promise<void> {
  const stats = service.getExtractionStats();
  res.json(stats);
}

export async function pipelines(_req: Request, res: Response): Promise<void> {
  const stats = service.getPipelineStats();
  res.json(stats);
}

export async function workers(_req: Request, res: Response): Promise<void> {
  const stats = service.getWorkerStats();
  res.json(stats);
}

export async function activity(req: Request, res: Response): Promise<void> {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
  const log = service.getActivityLog(limit, offset);
  res.json(log);
}
