import { getRequestId } from '../request-id/index.js';
const sensitive =
  /password|passwd|secret|token|authorization|cookie|api[-_]?key|credential/i;
/** Redact nested secret fields and suppress Error messages/stacks. Cycles are replaced. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== 'object' || value === null)
    return typeof value === 'bigint' ? String(value) : value;
  if (value instanceof Error) return { name: value.name };
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value))
    result[key] = sensitive.test(key) ? '[REDACTED]' : redact(item, seen);
  return result;
}
/** Structured logger with recursive field redaction. Do not put secrets in message text. */
export function createLogger(options: { write?: (line: string) => void } = {}) {
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  return {
    log(
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      fields: Record<string, unknown> = {},
    ) {
      write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message,
          requestId: getRequestId(),
          fields: redact(fields),
        }),
      );
    },
  };
}
