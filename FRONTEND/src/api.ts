export type ApiOptions = {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  rawBody?: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;

  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) {
    if (options.rawBody) {
      body = options.body as BodyInit;
    } else {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    });
  } catch {
    throw new ApiError(
      'Could not reach the API. Check the API URL and confirm that the backend is running.',
      0,
      null,
    );
  }

  const text = response.status === 204 ? '' : await response.text();
  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      value = text;
    }
  }

  if (!response.ok) {
    const error = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const message =
      (typeof error.detail === 'string' && error.detail) ||
      (typeof error.message === 'string' && error.message) ||
      (typeof error.title === 'string' && error.title) ||
      (typeof error.error === 'string' && error.error) ||
      `The API returned HTTP ${response.status}.`;
    throw new ApiError(message, response.status, value);
  }

  return value as T;
}

export function getRows(value: unknown, key = 'data'): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as Record<string, unknown>)[key];
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function displayDate(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dateAfter(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function toDateTimeInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
