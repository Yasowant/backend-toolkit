import { setTimeout as sleep } from 'node:timers/promises';
/** Mark a failure as terminal, regardless of retry predicates. */
export class NonRetryableError extends Error {
  readonly retryable = false;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}
/** Retry policy. retries counts additional attempts, not the initial call. */
export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  maxDelayMs?: number;
  backoff?: 'exponential' | 'fixed';
  jitter?: boolean;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  onRetry?: (
    error: unknown,
    attempt: number,
    delayMs: number,
  ) => void | Promise<void>;
}
/** Retry idempotent asynchronous work with bounded backoff and abortable waits. */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    delayMs = 100,
    maxDelayMs = 30000,
    backoff = 'exponential',
    jitter = false,
    signal,
  } = options;
  if (!Number.isSafeInteger(retries) || retries < 0)
    throw new RangeError('retries must be a non-negative safe integer');
  for (const [key, value] of Object.entries({ delayMs, maxDelayMs }))
    if (!Number.isFinite(value) || value < 0 || value > 2147483647)
      throw new RangeError(`${key} must be between 0 and 2147483647`);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      signal?.throwIfAborted();
      if (
        attempt >= retries ||
        (typeof error === 'object' &&
          error !== null &&
          'retryable' in error &&
          error.retryable === false) ||
        (options.shouldRetry && !(await options.shouldRetry(error, attempt)))
      )
        throw error;
      const base = Math.min(
        maxDelayMs,
        delayMs *
          (backoff === 'exponential' ? 2 ** Math.min(attempt, 1023) : 1),
      );
      const delay = jitter ? Math.random() * base : base;
      await options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay, undefined, { signal });
    }
  }
}
