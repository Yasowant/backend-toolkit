# @yasowant/backend-toolkit

Typed, modular building blocks for Node.js backends: consistent errors and responses, validated configuration, request context, retries, authorization, pagination, graceful shutdown, and reliable WebSocket connections.

**Requirements:** Node.js 22+, TypeScript 5+ recommended. Express 4.21+/5 and `ws` 8.18+ are optional peers. This is an initial **0.1.0** release: evaluate it against your workload before production adoption.

## Why this exists

Every backend needs the same plumbing, but utilities become dangerous when they obscure error handling, trust arbitrary input, or reconnect forever. This toolkit makes those policies explicit while keeping features independently importable. It provides no ORM, application framework, authentication provider, or automatic message replay.

## Installation

```sh
npm install @yasowant/backend-toolkit
# Install only the integrations you use:
npm install express
npm install ws
```

Both ESM `import` and CommonJS `require` are supported. Every feature has a subpath export:

```ts
import { retry } from '@yasowant/backend-toolkit/retry';
const { ApiError } = require('@yasowant/backend-toolkit/errors');
```

Core imports do not load Express, Mongoose, or `ws`. The `ws` peer is loaded only when a socket connects. Type declaration dependencies are included for TypeScript consumers.

## Quick start

```ts
import express from 'express';
import {
  ApiResponse,
  asyncHandler,
  errorHandler,
  requestId,
  validateEnv,
  env,
  createShutdown,
  createLogger,
} from '@yasowant/backend-toolkit';

const config = validateEnv({ PORT: env.default(env.number, 3000) });
const logger = createLogger();
const app = express();
app.use(requestId());
app.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json(ApiResponse.success({ status: 'ok' }));
  }),
);
app.use(errorHandler()); // Register last. Safe production responses by default.
const server = app.listen(config.PORT);
createShutdown({
  server,
  onError: () => {
    logger.log('error', 'Shutdown failed');
    process.exitCode = 1;
  },
});
```

## Features and API

### Error handling

`ApiError(statusCode, message, { cause?, code?, expose? })` retains the original cause. `httpErrors` offers factories for 400, 401, 403, 404, 409, 422, 429, 500, and 503.

```ts
import {
  ApiError,
  httpErrors,
  errorHandler,
} from '@yasowant/backend-toolkit/errors';
throw httpErrors.notFound('User not found');
// Or preserve a lower-level cause without returning it to clients:
throw new ApiError(503, 'Database unavailable', { cause: originalError });
// For a local development application only:
app.use(errorHandler({ development: true }));
```

Messages for 4xx errors are public by default; 5xx messages and unknown failures are hidden. Set `expose` deliberately when overriding this policy. Do not place secrets in public messages. Explicit development mode includes the original message/stack and must not be enabled on public services. Already-started responses are delegated to Express's next error handler.

### Async routes

`asyncHandler(handler)` forwards both synchronous throws and rejected promises, supporting Express 4 and 5. Await all work that belongs to the request. Do not both throw and call `next(error)` for the same failure.

```ts
app.get(
  '/users',
  asyncHandler(async (_req, res) => {
    res.json(
      ApiResponse.success(await loadUsers(), 'Users fetched successfully'),
    );
  }),
);
```

### Response envelopes

`ApiResponse.success(data, message?)`, `.error(message, code?)`, and `.paginated(data, total, pagination?, message?)` return plain JSON-compatible objects. They do not set HTTP status codes.

```ts
res.status(201).json(ApiResponse.success({ id: 'u1' }, 'Created'));
res.status(400).json(ApiResponse.error('Invalid input', 'VALIDATION_ERROR'));
res.json(ApiResponse.paginated(users, 100, { page: 1, limit: 20 }));
```

Pagination metadata includes `page`, `limit`, `total`, `totalPages`, `hasNextPage`, and `hasPreviousPage`.

### Environment validation

`validateEnv(schema, source = process.env)` returns inferred types, throwing `EnvValidationError` with all failing keys. It never includes input values or parser exception messages in validation errors.

```ts
import { validateEnv, env } from '@yasowant/backend-toolkit/config';
const config = validateEnv({
  DATABASE_URL: env.string,
  PORT: (value) => {
    const port = env.number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid port');
    return port;
  },
  DEBUG: env.default(env.boolean, false),
});
```

`env.boolean` accepts exactly `true`/`false`; `env.number` accepts finite numeric strings; `env.string` rejects empty/whitespace-only values. Defaults apply only to absent variables. Validate before opening a server. Custom parsers can enforce URL, enum, or port constraints.

### Request and correlation IDs

`requestId({ trustHeader?, header? })` writes `req.requestId`, `res.locals.requestId`, the response header, and async-local context. `getRequestId()` retrieves context through awaited calls.

```ts
app.use(requestId()); // Generates a new UUID; does not trust external IDs.
// Behind a trusted gateway, opt in to bounded, validated incoming IDs:
app.use(requestId({ trustHeader: true, header: 'x-correlation-id' }));
```

Choose one of these configurations. Incoming IDs allow only letters, digits, `.`, `_`, `:`, and `-`, up to 128 characters. Invalid IDs are replaced. Context is undefined outside a request; it is not propagated automatically between processes.

### Retry

`retry(operation, options)` passes a zero-based attempt number. `retries` defaults to 3 additional tries, `delayMs` to 100, `maxDelayMs` to 30000, and `backoff` to `exponential`. Set `backoff: 'fixed'` for constant waits or `jitter: true` for full jitter.

```ts
import { retry, NonRetryableError } from '@yasowant/backend-toolkit/retry';
const result = await retry(
  async () => {
    const response = await fetch(url, { signal });
    if (response.status === 401) throw new NonRetryableError('Unauthorized');
    if (!response.ok) throw new Error('Temporary upstream failure');
    return response.json();
  },
  { retries: 3, jitter: true, signal },
);
```

`shouldRetry(error, attempt)` can be asynchronous. `onRetry(error, nextAttempt, delayMs)` runs before a wait. Errors with `retryable: false` never retry. Exhaustion rethrows the original error. Abort cancels waits; pass the same signal into your operation to cancel in-flight work. Retry only idempotent operations or requests protected by idempotency keys.

### Graceful shutdown

`createShutdown({ server, closers?, timeoutMs?, signals?, onError? })` installs SIGINT/SIGTERM handlers and returns `{ shutdown, dispose }`. `shutdown()` is idempotent; `dispose()` removes signal listeners without closing resources.

```ts
const lifecycle = createShutdown({
  server,
  timeoutMs: 15000,
  closers: [() => mongoose.disconnect(), () => socket.close()],
  onError: (error) => {
    reportShutdownFailure(error);
    process.exitCode = 1;
  },
});
await lifecycle.shutdown(); // Also usable in tests or a process supervisor.
```

HTTP draining and resource closers start concurrently. Cleanup failures are collected in an `AggregateError`. A deadline force-closes HTTP connections and rejects. It cannot cancel arbitrary database/closer promises or force-close upgraded WebSocket connections: provide bounded closers and terminate server-side WebSockets yourself. The library does not call `process.exit`. Without `onError`, signal-triggered failures set exit code 1 and emit a generic warning.

### Pagination and Mongoose

`paginate({ page = 1, limit = 20, maxLimit = 100 })` returns `{ page, limit, skip }`. Invalid integers throw; excessive limits are capped. `paginationMeta(total, options)` computes navigation. Empty datasets have zero pages; out-of-range pages are not silently rewritten.

```ts
const { skip, limit } = paginate({ page: 2, limit: 20 });
const rows = allRows.slice(skip, skip + limit);

// Pass matching filters and deterministic ordering:
const page = await paginateMongoose(
  User.find({ active: true }).sort({ _id: 1 }),
  () => User.countDocuments({ active: true }).exec(),
  { page: 1, limit: 20 },
);
```

No Mongoose dependency is installed. Parse and validate HTTP query strings before passing numeric values. Offset pagination becomes expensive at deep pages; use cursor pagination for very large datasets. Query/count execute concurrently and may observe different snapshots unless the caller supplies a suitable transaction.

### RBAC and permissions

`hasAccess(principal, policy)` is framework-independent. `authorize(policy)` reads `req.user` by default or uses an asynchronous `getPrincipal(req)` resolver. All requested roles and permissions must match by default. `mode: 'any'` accepts any one match across both lists.

```ts
app.get(
  '/users',
  authorize({
    permissions: ['user.read'],
    getPrincipal: (req) => resolveAuthenticatedPrincipal(req),
  }),
  listUsers,
);
```

Missing identity returns 401; denied access returns 403. Empty middleware policies throw at configuration time; empty `hasAccess` policies return false. Roles/permissions are exact, case-sensitive strings; no implicit inheritance or wildcards. Your authentication layer must verify identity—never derive permissions directly from untrusted headers.

### Structured logging

```ts
const logger = createLogger({ write: (line) => logSink.write(line + '\n') });
logger.log('info', 'Request complete', {
  status: 200,
  accessToken: 'redacted',
});
```

The logger includes time, level, message, request ID, and fields. `redact(value)` recursively removes password, token, secret, authorization, cookie, API key, and credential-like fields. Error objects expose only their name; cycles are marked. Free-text messages and unrecognized fields cannot be reliably sanitized: never put credentials or personal data in them. Sink errors propagate to the caller.

### Reliable WebSockets

```ts
import { createReliableSocket } from '@yasowant/backend-toolkit/websocket';
const socket = createReliableSocket({
  url: 'wss://api.example.com',
  reconnect: true,
  maxRetries: 10,
  heartbeatInterval: 30000,
  authenticate: async (signal) => ({
    headers: { Authorization: `Bearer ${await refreshAccessToken(signal)}` },
  }),
  onReconnect: (attempt, delayMs) =>
    logger.log('info', 'Reconnecting', { attempt, delayMs }),
  onError: () => logger.log('error', 'WebSocket operation failed'),
  onMessage: (data) => consumeMessage(data),
});
await socket.subscribe('users', () =>
  JSON.stringify({ type: 'subscribe', channel: 'users' }),
);
await socket.connect();
await socket.send(JSON.stringify({ type: 'request', id: 'req-1' }));
await socket.unsubscribe(
  'users',
  JSON.stringify({ type: 'unsubscribe', channel: 'users' }),
);
await socket.close();
```

The client starts only when `connect()` is called. That promise resolves after connection and subscription writes, or rejects on terminal failure. Authentication is refreshed before every attempt and receives an abort signal. Subscription factories replay on reconnection. Callbacks cover connection, disconnection, retries, messages, errors, and state changes. Callback failures are sent to `onError`; without it, a generic warning is emitted.

| Option                   | Default     | Meaning                                               |
| ------------------------ | ----------- | ----------------------------------------------------- |
| `maxRetries`             | 10          | Additional attempts per failure streak                |
| `delayMs` / `maxDelayMs` | 250 / 30000 | Capped exponential reconnect delay                    |
| `jitter`                 | true        | Random delay between zero and the backoff cap         |
| `connectionTimeout`      | 10000       | Deadline covering auth, module load, and handshake    |
| `stableConnectionMs`     | 10000       | Healthy connection duration before retry count resets |
| `heartbeatInterval`      | 30000       | Native ping interval; zero disables                   |
| `heartbeatTimeout`       | 10000       | Deadline for pong                                     |
| `maxBufferedBytes`       | 1048576     | Bound queued outgoing bytes                           |
| `maxPayloadBytes`        | 1048576     | Maximum incoming message size                         |

States are `idle`, `connecting`, `open`, `reconnecting`, and `closed`. `close()` cancels timers/auth, clears subscriptions, starts the close handshake, and terminates after one second if necessary. Closed clients are terminal: create a new instance to start again. Messages sent while disconnected reject; they are never replayed automatically. A successful `send` means transport handoff, not server acknowledgement or exactly-once delivery. Native ping/pong requires a compatible server; this is a Node.js client, not a browser client.

## Tests and packaging

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
npm run test:package
```

Tests include Express middleware, request isolation, original-error propagation, retry cancellation, query adapters, cleanup deadlines, and real WebSocket reconnect/heartbeat scenarios. The package smoke test installs the tarball and verifies all ESM/CommonJS exports and TypeScript declarations without optional peers.

## Documentation and examples

- [Architecture](docs/architecture.md)
- [Validation and edge cases](docs/validation.md)
- [Release guide](docs/releasing.md)
- [Runnable Express example](examples/server.ts)
- [WebSocket example](examples/socket.ts)

## Contributing and versioning

See [CONTRIBUTING.md](CONTRIBUTING.md). Run the full checks before opening a pull request. Never include credentials in fixtures or bug reports. Versions follow SemVer: during 0.x, breaking changes increment the minor version; after 1.0, they increment the major version. Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © 2026 Yasowant.
