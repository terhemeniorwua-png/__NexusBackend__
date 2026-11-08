import type { RequestHandler } from 'express';
import type { Logger } from '../utils/logger';
import { redactSensitivePath } from '../utils/log-redaction';

export function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const path = redactSensitivePath(req.originalUrl.split('?')[0] ?? req.originalUrl);

      logger.info('http_request', {
        requestId: req.requestId,
        method: req.method,
        path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
    });

    next();
  };
}
