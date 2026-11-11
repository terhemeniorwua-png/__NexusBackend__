import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../config/env';
import type { ReadinessProbe } from '../services/health';
import type { QueueStatus, QueueStatusProbe } from '../services/workers/queue-status';
import type { WorkerHealthRegistry } from '../services/workers/worker-health';
import { sendSuccess } from '../utils/http';
import { withTimeout } from '../utils/timeout';

export type { QueueStatus, QueueStatusProbe } from '../services/workers/queue-status';

interface HealthRouterOptions {
  config: Pick<AppConfig, 'appName' | 'appVersion' | 'nodeEnv'>;
  readinessProbe: ReadinessProbe;
  workerHealth?: WorkerHealthRegistry;
  queueStatusProbe?: QueueStatusProbe;
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

const QUEUE_STATUS_TIMEOUT_MS = 2_000;

export function createHealthRouter({
  config,
  readinessProbe,
  workerHealth,
  queueStatusProbe,
}: HealthRouterOptions): Router {
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

  /**
   * Background-processing health.
   *
   * The response reports worker liveness and durable queue depth only. Job
   * payloads, recipient addresses and raw error messages are deliberately
   * excluded so the endpoint can be probed without exposing business data.
   */
  router.get('/workers', async (req, res, next) => {
    try {
      const report = workerHealth?.snapshot() ?? {
        status: 'ok' as const,
        checkedAt: new Date().toISOString(),
        staleAfterMs: 0,
        workers: [],
      };

      let queues: QueueStatus[] = [];

      if (queueStatusProbe) {
        try {
          queues = await withTimeout(
            queueStatusProbe(),
            QUEUE_STATUS_TIMEOUT_MS,
            'Queue status probe timed out',
          );
        } catch {
          // A queue-depth probe failure must not make an otherwise healthy
          // process look dead. Worker liveness is still reported.
          queues = [];
        }
      }

      const healthy = report.status === 'ok';
      const data = {
        status: report.status,
        ...baseHealthData(config),
        staleAfterMs: report.staleAfterMs,
        workers: report.workers,
        queues,
        requestId: req.requestId,
      };

      res.status(healthy ? 200 : 503).json({
        success: healthy,
        data,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
