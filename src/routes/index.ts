import { Router } from 'express';
import type { AppConfig } from '../config/env';
import type { ReadinessProbe } from '../services/health';
import { createHealthRouter } from './health';

interface ApiRouterOptions {
  config: AppConfig;
  readinessProbe: ReadinessProbe;
}

export function createApiRouter({ config, readinessProbe }: ApiRouterOptions): Router {
  const router = Router();

  router.use('/health', createHealthRouter({ config, readinessProbe }));

  return router;
}
