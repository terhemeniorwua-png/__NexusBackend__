import type { Response } from 'express';

export interface SuccessResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
  requestId?: string;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): Response<SuccessResponse<T>> {
  const body: SuccessResponse<T> = {
    success: true,
    data,
    ...(meta ? { meta } : {}),
    ...(res.locals.requestId ? { requestId: String(res.locals.requestId) } : {}),
  };

  return res.status(statusCode).json(body);
}
