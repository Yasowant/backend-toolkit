import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
const context = new AsyncLocalStorage<string>();
declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}
/** Retrieve the request ID within the current asynchronous request context. */
export function getRequestId(): string | undefined {
  return context.getStore();
}
/** Add validated request IDs. Trust inbound IDs only behind a trusted gateway. */
export function requestId(
  options: { trustHeader?: boolean; header?: string } = {},
): RequestHandler {
  const header = options.header ?? 'x-request-id';
  if (!/^[a-zA-Z0-9-]+$/.test(header))
    throw new TypeError('Invalid request ID header name');
  return (req, res, next) => {
    const incoming = options.trustHeader ? req.get(header) : undefined;
    const id =
      incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    req.requestId = id;
    res.locals.requestId = id;
    res.setHeader(header, id);
    context.run(id, next);
  };
}
