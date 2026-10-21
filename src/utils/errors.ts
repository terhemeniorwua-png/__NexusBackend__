export type ErrorDetails = unknown;

interface AppErrorOptions {
  details?: ErrorDetails;
  cause?: unknown;
  expose?: boolean;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: ErrorDetails;
  readonly expose: boolean;

  constructor(statusCode: number, code: string, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: ErrorDetails) {
    super(400, 'VALIDATION_ERROR', message, { details });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'A required service is unavailable', details?: ErrorDetails) {
    super(503, 'SERVICE_UNAVAILABLE', message, { details });
    this.name = 'ServiceUnavailableError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
