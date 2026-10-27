import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import { ValidationError } from '../errors/index.js';

type ValidationSchemas = {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  headers?: ZodType;
};

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const errors: z.ZodIssue[] = [];
    for (const [source, schema] of Object.entries(schemas) as [
      keyof ValidationSchemas,
      ZodType,
    ][]) {
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        errors.push(
          ...result.error.issues.map((issue) => ({ ...issue, path: [source, ...issue.path] })),
        );
      } else {
        (req as Request & Record<string, unknown>)[source] = result.data;
      }
    }
    if (errors.length > 0) {
      next(new ValidationError('Request validation failed.', errors));
      return;
    }
    next();
  };
}

export const strictObject = z.object;
