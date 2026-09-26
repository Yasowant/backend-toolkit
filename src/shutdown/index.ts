import type { Server } from 'node:http';
/** Application resources to close concurrently with HTTP draining. */
export interface ShutdownOptions {
  server: Server;
  closers?: readonly (() => void | Promise<void>)[];
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
  onError?: (error: unknown) => void;
}
/** Install signal handlers and return an idempotent shutdown controller; never calls process.exit. */
export function createShutdown({
  server,
  closers = [],
  timeoutMs = 10000,
  signals = ['SIGINT', 'SIGTERM'],
  onError,
}: ShutdownOptions) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new RangeError('timeoutMs must be positive and at most 2147483647');
  let pending: Promise<void> | undefined;
  const handler = () => {
    void shutdown().catch((error) => {
      if (onError) onError(error);
      else {
        process.exitCode = 1;
        process.emitWarning(
          'Graceful shutdown failed; inspect resources or provide onError',
        );
      }
    });
  };
  /** Remove installed listeners without stopping resources. */
  function dispose() {
    for (const signal of signals) process.off(signal, handler);
  }
  /** Stop accepting HTTP requests, drain resources, and reject on deadline or cleanup failure. */
  function shutdown(): Promise<void> {
    if (pending) return pending;
    dispose();
    pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
        reject(new Error('Graceful shutdown timed out'));
      }, timeoutMs);
      const http = new Promise<void>((done, fail) =>
        server.close((error) =>
          error &&
          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? fail(error)
            : done(),
        ),
      );
      Promise.allSettled([
        http,
        ...closers.map((close) => Promise.resolve().then(close)),
      ]).then((results) => {
        clearTimeout(timer);
        const errors = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((result) => result.reason);
        if (errors.length)
          reject(
            new AggregateError(errors, 'Graceful shutdown resource failures'),
          );
        else resolve();
      });
    });
    return pending;
  }
  for (const signal of signals) process.on(signal, handler);
  return { shutdown, dispose };
}
