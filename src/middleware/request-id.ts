import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const requestIdHeader = 'x-request-id';
const safeRequestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(requestIdHeader);
  const id = incoming && safeRequestIdPattern.test(incoming) ? incoming : randomUUID();

  req.requestId = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);

  next();
};
