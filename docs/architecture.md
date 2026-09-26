# Architecture and API contract

Version 0.1.0 targets Node.js 22 and later. Each module has an independent subpath export; both ESM and CommonJS include declarations. Express is type-only. The WebSocket transport loads the optional `ws` peer lazily so importing the root does not require it. Mongoose integration uses a structural query adapter, avoiding a mandatory ORM dependency.

## Design decisions

- Errors: `ApiError(status, message, {cause, code, expose})`, `httpErrors`, `errorHandler({development})`. Unknown errors become a generic 500. An explicitly exposed message is public; never put secrets in it. Development diagnostics are opt-in.
- Async routes: `asyncHandler(handler)` catches synchronous throws and asynchronous rejections. Do not both call `next(error)` and throw in the same handler.
- Responses: `ApiResponse.success`, `.error`, `.paginated` return plain objects, leaving status/headers to the application.
- Configuration: `validateEnv(schema, source)` infers types from field parsers. Aggregate failures name invalid keys without echoing values.
- Request IDs: `requestId()` creates IDs and AsyncLocalStorage context. Existing headers are trusted only when explicitly configured and are validated.
- Retry: `retry(operation, options)` uses capped delays, optional full jitter, cancellation and a `NonRetryableError` escape hatch. Callers remain responsible for operation idempotency.
- Shutdown: `createShutdown({server, closers, timeoutMs})` returns explicit `shutdown` and `dispose` methods. A deadline force-closes HTTP connections and rejects; the application decides its process exit policy. Closers start concurrently so WebSockets cannot deadlock HTTP draining.
- Pagination: `paginate`, `paginationMeta`, `paginateMongoose` validate limits and protect offset arithmetic. Mongoose filtering/count consistency remains the caller's responsibility; use a transaction when a snapshot is required.
- Authorization: `authorize({getPrincipal, roles, permissions, mode})` supports dynamic principals and no hard-coded roles. Missing identity is 401, insufficient access is 403. This does not authenticate requests.
- Logging: `createLogger({write})` accepts structured fields and redacts secret-like keys recursively. Never automatically log arbitrary errors, request bodies or tokens. Free-text messages are the application's responsibility.
- WebSockets: `createReliableSocket` has explicit `connect`, `send`, `close`, `subscribe` and `unsubscribe` methods. State transitions: idle → connecting → open → reconnecting → connecting, then closed after explicit shutdown or retry exhaustion. Authentication is resolved before every connection; generation checks prevent late hook completions from reviving a closed client. Native ping/pong detects dead connections. No queued message replay: reliable transport is not exactly-once delivery. Consumers need application acknowledgements for that.

## Verification strategy

Core modules first, with lint, strict typing, Express integration tests and dual-format build. Then configuration, responses, request context, retry, pagination, authorization and logging tests. WebSocket tests use a real local server, including reconnect, resubscribe, timeout, heartbeat and shutdown paths. Packaging smoke checks load every export from the actual tarball in both module systems. CI tests Node 22 and 24, and Express 4 and 5. Release publishing is manually dispatched, requires explicit version confirmation and supports npm trusted publishing.
