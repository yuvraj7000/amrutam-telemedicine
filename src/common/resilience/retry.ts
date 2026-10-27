export interface RetryOptions {
  retries: number;
  baseMs: number;
  capMs: number;
  retryOn: (error: unknown) => boolean;
  signal?: AbortSignal;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void | Promise<void>;
}

export function backoffDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  random = Math.random,
): number {
  return random() * Math.min(capMs, baseMs * 2 ** attempt);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await fn();
    } catch (error) {
      if (attempt >= options.retries || !options.retryOn(error)) throw error;
      const delayMs = backoffDelay(attempt, options.baseMs, options.capMs, options.random);
      await options.onRetry?.(error, attempt + 1, delayMs);
      await (options.sleep ?? sleep)(delayMs, options.signal);
    }
  }
}
