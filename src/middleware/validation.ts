import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../utils/errors';

export interface RequestSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

type ValidationTarget = keyof RequestSchemas;

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: Array<{ field: string; message: string }> = [];
    const validated: NonNullable<typeof req.validated> = { ...req.validated };

    for (const target of Object.keys(schemas) as ValidationTarget[]) {
      const schema = schemas[target];

      if (!schema) {
        continue;
      }

      // A request without a body is treated as an empty object so that
      // endpoints with an optional body can be called without one.
      const source = target === 'body' ? (req.body ?? {}) : req[target];
      const result = schema.safeParse(source);

      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            field: [target, ...issue.path.map(String)].join('.'),
            message: issue.message,
          });
        }
        continue;
      }

      validated[target] = result.data;

      if (target === 'body') {
        req.body = result.data;
      }

      if (target === 'params') {
        req.params = result.data as typeof req.params;
      }
    }

    if (issues.length > 0) {
      next(new ValidationError('The request contains invalid data', issues));
      return;
    }

    req.validated = validated;
    next();
  };
}

export function validateBody(schema: ZodType): RequestHandler {
  return validate({ body: schema });
}
