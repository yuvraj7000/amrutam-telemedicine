import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, ERROR_CODES, ValidationError } from '../errors/index.js';
import { logger } from '../observability/logger.js';

type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId?: string;
  errors?: readonly unknown[];
};

function titleFor(status: number): string {
  return status >= 500
    ? 'Internal Server Error'
    : status === 422
      ? 'Validation Error'
      : 'Request Error';
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  void next;
  const requestId = res.locals.requestId as string | undefined;
  const appError =
    error instanceof ZodError
      ? new ValidationError('Request validation failed.', error.issues)
      : error instanceof AppError
        ? error
        : new AppError(ERROR_CODES.INTERNAL_ERROR, 500, 'An unexpected error occurred.', {
            cause: error,
          });

  if (!(error instanceof AppError) && !(error instanceof ZodError)) {
    logger.error(
      { err: error, requestId, method: req.method, route: req.originalUrl },
      'Unhandled request error',
    );
  }

  const problem: ProblemDetails = {
    type: `https://api.amrutam.example/errors/${appError.code.toLowerCase().replaceAll('_', '-')}`,
    title: titleFor(appError.status),
    status: appError.status,
    code: appError.code,
    detail:
      process.env.NODE_ENV === 'production' && appError.status >= 500
        ? 'An unexpected error occurred.'
        : appError.detail,
    requestId,
    ...(appError.errors ? { errors: appError.errors } : {}),
  };
  const retryAfter = (appError as AppError & { retryAfter?: number }).retryAfter;
  if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
  res.status(appError.status).type('application/problem+json').json(problem);
};
