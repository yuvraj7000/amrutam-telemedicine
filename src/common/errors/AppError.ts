import type { ErrorCode } from './error-codes.js';

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly detail: string;
  public readonly errors?: readonly unknown[];

  public constructor(
    code: ErrorCode,
    status: number,
    detail: string,
    options?: { cause?: unknown; errors?: readonly unknown[] },
  ) {
    super(detail, { cause: options?.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.errors = options?.errors;
  }
}
