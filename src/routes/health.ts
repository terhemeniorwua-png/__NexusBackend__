import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../config/env';
import type { ReadinessProbe } from '../services/health';
import { sendSuccess } from '../utils/http';

interface HealthRouterOptions {
  config: Pick<AppConfig, 'appName' | 'appVersion' | 'nodeEnv'>;
  readinessProbe: ReadinessProbe;
}

function baseHealthData(config: HealthRouterOptions['config']) {
  return {
    service: config.appName,
    version: config.appVersion,
    environment: config.nodeEnv,
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  };
}

export function createHealthRouter({ config, readinessProbe }: HealthRouterOptions): Router {
  const router = Router();

  const liveness = (_req: Request, res: Response) => {
    sendSuccess(res, {
      status: 'ok',
      ...baseHealthData(config),
    });
  };

  router.get('/', liveness);
  router.get('/live', liveness);

  router.get('/ready', async (req, res, next) => {
    try {
      const readiness = await readinessProbe();
      const ready = readiness.status === 'ready';
      const data = {
        status: readiness.status,
        ...baseHealthData(config),
        dependencies: readiness.dependencies,
        requestId: req.requestId,
      };

      res.status(ready ? 200 : 503).json({
        success: ready,
        data,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
