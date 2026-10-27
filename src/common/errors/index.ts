import { AppError } from './AppError.js';
import { ERROR_CODES, type ErrorCode } from './error-codes.js';

export { AppError, ERROR_CODES };
export type { ErrorCode };

export class NotFoundError extends AppError {
  public constructor(detail = 'The requested resource was not found.') {
    super(ERROR_CODES.NOT_FOUND, 404, detail);
  }
}

export class ConflictError extends AppError {
  public constructor(
    code: ErrorCode = ERROR_CODES.INVALID_STATE,
    detail = 'The request conflicts with the current state.',
  ) {
    super(code, 409, detail);
  }
}

export class ValidationError extends AppError {
  public constructor(detail = 'The request contains invalid values.', errors?: readonly unknown[]) {
    super(ERROR_CODES.VALIDATION_ERROR, 422, detail, { errors });
  }
}

export class UnauthorizedError extends AppError {
  public constructor(
    code: ErrorCode = ERROR_CODES.UNAUTHENTICATED,
    detail = 'Authentication is required.',
  ) {
    super(code, 401, detail);
  }
}

export class ForbiddenError extends AppError {
  public constructor(
    code: ErrorCode = ERROR_CODES.FORBIDDEN,
    detail = 'You are not allowed to perform this action.',
  ) {
    super(code, 403, detail);
  }
}

export class RateLimitError extends AppError {
  public constructor(detail = 'Too many requests. Please try again later.') {
    super(ERROR_CODES.RATE_LIMITED, 429, detail);
  }
}

export class ServiceUnavailableError extends AppError {
  public constructor(detail = 'The service is temporarily unavailable.') {
    super(ERROR_CODES.SERVICE_UNAVAILABLE, 503, detail);
  }
}
