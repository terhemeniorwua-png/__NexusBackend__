import type { RequestHandler } from 'express';
import type { AnySchema, ValidationError as JoiValidationError } from 'joi';
import type { ZodType } from 'zod';
import { ValidationError } from '../utils/errors';

type RequestSchema = ZodType | AnySchema;

export interface RequestSchemas {
  body?: RequestSchema;
  params?: RequestSchema;
  query?: RequestSchema;
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
      const result = parseRequestValue(schema, source);

      if (!result.success) {
        for (const issue of result.issues) {
          issues.push({
            field: [target, ...issue.path].join('.'),
            message: issue.message,
          });
        }
        continue;
      }

      validated[target] = result.value;

      if (target === 'body') {
        req.body = result.value;
      }

      if (target === 'params') {
        req.params = result.value as typeof req.params;
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

export function validateBody(schema: RequestSchema): RequestHandler {
  return validate({ body: schema });
}

type ParsedRequestValue =
  | { success: true; value: unknown; issues: [] }
  | { success: false; value: undefined; issues: Array<{ path: string[]; message: string }> };

function parseRequestValue(schema: RequestSchema, source: unknown): ParsedRequestValue {
  if ('safeParse' in schema && typeof schema.safeParse === 'function') {
    const result = schema.safeParse(source);

    if (result.success) {
      return { success: true, value: result.data, issues: [] };
    }

    return {
      success: false,
      value: undefined,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  }

  const result = (schema as AnySchema).validate(source, {
    abortEarly: false,
    allowUnknown: false,
    convert: true,
    stripUnknown: false,
  }) as { error?: JoiValidationError; value: unknown };

  if (!result.error) {
    return { success: true, value: result.value, issues: [] };
  }

  return {
    success: false,
    value: undefined,
    issues: result.error.details.map((detail) => ({
      path: detail.path.map(String),
      message: detail.message,
    })),
  };
}
