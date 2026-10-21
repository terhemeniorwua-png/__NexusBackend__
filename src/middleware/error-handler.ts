import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { AppConfig } from '../config/env';
import { AppError, ValidationError, isAppError } from '../utils/errors';
import type { Logger } from '../utils/logger';

interface ParsedHttpError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

function isParsedHttpError(error: unknown): error is ParsedHttpError {
  return error instanceof Error;
}

function normalizeError(error: unknown, isProduction: boolean): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof ZodError) {
    return new ValidationError(
      'The request contains invalid data',
      error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  if (isParsedHttpError(error)) {
    if (error.type === 'entity.parse.failed') {
      return new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON');
    }

    if (error.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
    }

    const status = error.status ?? error.statusCode;

    if (status && status >= 400 && status < 500) {
      return new AppError(
        status,
        'BAD_REQUEST',
        isProduction ? 'The request could not be processed' : error.message,
      );
    }
  }

  return new AppError(500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred', {
    cause: error,
    expose: false,
  });
}

export function createErrorHandler(
  logger: Logger,
  config: Pick<AppConfig, 'isProduction'>,
): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const normalized = normalizeError(error, config.isProduction);
    const context = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: normalized.statusCode,
      code: normalized.code,
      error,
    };

    if (normalized.statusCode >= 500) {
      logger.error('request_error', context);
    } else {
      logger.warn('request_error', context);
    }

    const message =
      normalized.expose || !config.isProduction
        ? normalized.message
        : 'An unexpected error occurred';

    res.status(normalized.statusCode).json({
      success: false,
      error: {
        code: normalized.code,
        message,
        ...(normalized.details !== undefined ? { details: normalized.details } : {}),
        requestId: req.requestId,
      },
    });
  };
}
