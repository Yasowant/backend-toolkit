import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  ApiResponse,
  env,
  validateEnv,
  EnvValidationError,
  paginate,
  paginationMeta,
  paginateMongoose,
  retry,
  NonRetryableError,
  requestId,
  getRequestId,
  authorize,
  hasAccess,
  redact,
  createLogger,
  createShutdown,
} from '../src/index.js';
import { createServer } from 'node:http';

describe('responses and pagination', () => {
  it('returns consistent envelopes', () => {
    expect(ApiResponse.success([1], 'Done')).toEqual({
      success: true,
      message: 'Done',
      data: [1],
    });
    expect(ApiResponse.error('No')).toEqual({
      success: false,
      message: 'No',
      error: { code: 'API_ERROR' },
    });
    expect(ApiResponse.paginated([1], 3, { limit: 1 }).meta.hasNextPage).toBe(
      true,
    );
  });
  it('validates and caps pagination', () => {
    expect(paginate({ page: 2, limit: 1000 })).toEqual({
      page: 2,
      limit: 100,
      skip: 100,
    });
    for (const page of [0, -1, NaN, 1.2, Infinity])
      expect(() => paginate({ page })).toThrow();
    expect(() =>
      paginate({ page: Number.MAX_SAFE_INTEGER, limit: 100 }),
    ).toThrow();
    expect(() => paginationMeta(-1)).toThrow();
    expect(paginationMeta(0).totalPages).toBe(0);
    expect(paginationMeta(100, { page: 5 }).hasNextPage).toBe(false);
    expect(paginationMeta(100, { page: 5 }).hasPreviousPage).toBe(true);
  });
  it('adapts structural Mongoose queries', async () => {
    const query = {
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      exec: async () => [{ id: 1 }],
    };
    const result = await paginateMongoose(query, async () => 25, {
      page: 2,
      limit: 10,
    });
    expect(query.skip).toHaveBeenCalledWith(10);
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(result.meta.totalPages).toBe(3);
    expect(result.data[0]?.id).toBe(1);
  });
});
describe('configuration', () => {
  it('infers required and default values', () => {
    const config = validateEnv(
      {
        PORT: env.number,
        NAME: env.string,
        DEBUG: env.boolean,
        DEFAULT: env.default(env.string, 'ok'),
      },
      { PORT: '3000', NAME: 'app', DEBUG: 'false' },
    );
    expect(config).toEqual({
      PORT: 3000,
      NAME: 'app',
      DEBUG: false,
      DEFAULT: 'ok',
    });
    expect(env.boolean('true')).toBe(true);
  });
  it('aggregates keys without leaking values', () => {
    try {
      validateEnv(
        { TOKEN: env.number, NAME: env.string, BOOL: env.boolean },
        { TOKEN: 'secret', BOOL: 'yes' },
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('TOKEN, NAME, BOOL');
      expect((error as Error).message).not.toContain('secret');
    }
    expect(() => env.number('')).toThrow();
    expect(() => env.number('Infinity')).toThrow();
  });
});
describe('retry', () => {
  it('counts attempts and caps exponential waits', async () => {
    const delays: number[] = [];
    let calls = 0;
    expect(
      await retry(
        async () => {
          if (calls++ < 3) throw new Error('transient');
          return 42;
        },
        {
          delayMs: 1,
          maxDelayMs: 2,
          onRetry: (_e, _n, delay) => {
            delays.push(delay);
          },
        },
      ),
    ).toBe(42);
    expect(delays).toEqual([1, 2, 2]);
  });
  it('propagates original terminal errors', async () => {
    const error = new NonRetryableError('stop');
    const fn = vi.fn().mockRejectedValue(error);
    await expect(retry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(retry(fn, { retries: -1 })).rejects.toThrow(RangeError);
    await expect(retry(fn, { delayMs: Infinity })).rejects.toThrow(RangeError);
  });
  it('supports predicates, exhaustion, fixed jitter and cancellation', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('no'));
    await expect(retry(fn, { shouldRetry: () => false })).rejects.toThrow('no');
    expect(fn).toHaveBeenCalledTimes(1);
    fn.mockClear();
    await expect(
      retry(fn, { retries: 2, delayMs: 0, backoff: 'fixed', jitter: true }),
    ).rejects.toThrow('no');
    expect(fn).toHaveBeenCalledTimes(3);
    const controller = new AbortController();
    controller.abort();
    await expect(retry(fn, { signal: controller.signal })).rejects.toThrow();
  });
  it('aborts during a retry wait', async () => {
    const controller = new AbortController();
    const promise = retry(
      async () => {
        throw new Error('retry');
      },
      {
        delayMs: 10000,
        signal: controller.signal,
        onRetry: () => {
          setTimeout(() => controller.abort(), 5);
        },
      },
    );
    await expect(promise).rejects.toThrow();
  });
});
describe('request context and authorization', () => {
  it('isolates concurrent request IDs and logs safely', async () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line) });
    const app = express();
    app.use(requestId({ trustHeader: true }));
    app.get('/', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.log('info', 'Handled', { token: 'secret' });
      res.json({ id: getRequestId(), attached: req.requestId });
    });
    const responses = await Promise.all(
      ['one', 'two'].map((id) => request(app).get('/').set('x-request-id', id)),
    );
    expect(responses.map((r) => r.body.id)).toEqual(['one', 'two']);
    expect(responses[0]?.body.attached).toBe('one');
    expect(lines.map((line) => JSON.parse(line).requestId).sort()).toEqual([
      'one',
      'two',
    ]);
    expect(lines.join('')).not.toContain('secret');
    expect(getRequestId()).toBeUndefined();
  });
  it('ignores untrusted and invalid IDs', async () => {
    for (const options of [{}, { trustHeader: true }]) {
      const app = express();
      app.use(requestId(options));
      app.get('/', (_req, res) => res.end());
      const response = await request(app)
        .get('/')
        .set('x-request-id', 'bad id');
      expect(response.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/);
    }
    expect(() => requestId({ header: 'bad header' })).toThrow();
  });
  it('evaluates dynamic policies and distinguishes authentication from authorization', async () => {
    expect(
      hasAccess(
        { roles: ['editor'], permissions: ['post.read'] },
        { roles: ['editor'], permissions: ['post.read'] },
      ),
    ).toBe(true);
    expect(
      hasAccess(
        { roles: ['editor'] },
        { roles: ['other'], permissions: ['x'], mode: 'any' },
      ),
    ).toBe(false);
    expect(
      hasAccess(
        { roles: ['editor'] },
        { roles: ['other', 'editor'], mode: 'any' },
      ),
    ).toBe(true);
    expect(hasAccess({}, {})).toBe(false);
    expect(() => authorize({})).toThrow();
    const app = express();
    app.get(
      '/',
      authorize({
        permissions: ['read'],
        getPrincipal: (req) =>
          req.get('user')
            ? { permissions: req.get('user') === 'yes' ? ['read'] : [] }
            : null,
      }),
      (_req, res) => res.sendStatus(204),
    );
    expect((await request(app).get('/')).status).toBe(401);
    expect((await request(app).get('/').set('user', 'no')).status).toBe(403);
    expect((await request(app).get('/').set('user', 'yes')).status).toBe(204);
  });
});
describe('redaction', () => {
  it('handles nested fields, errors and cycles', () => {
    const fields: Record<string, unknown> = {
      nested: [{ apiKey: 'secret', safe: 42 }],
      error: new Error('secret'),
      count: 1n,
    };
    fields.self = fields;
    expect(redact(fields)).toEqual({
      nested: [{ apiKey: '[REDACTED]', safe: 42 }],
      error: { name: 'Error' },
      count: '1',
      self: '[Circular]',
    });
  });
});
describe('shutdown', () => {
  it('closes listening server and resources exactly once', async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const close = vi.fn();
    const before = process.listenerCount('SIGTERM');
    const ctl = createShutdown({ server, closers: [close] });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    const first = ctl.shutdown();
    expect(ctl.shutdown()).toBe(first);
    await first;
    expect(close).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    ctl.dispose();
  });
  it('reports cleanup failure and times out hung resources', async () => {
    await expect(
      createShutdown({
        server: createServer(),
        closers: [
          () => {
            throw new Error('cleanup');
          },
        ],
        signals: [],
      }).shutdown(),
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(
      createShutdown({
        server: createServer(),
        closers: [() => new Promise(() => {})],
        timeoutMs: 5,
        signals: [],
      }).shutdown(),
    ).rejects.toThrow('timed out');
    expect(() =>
      createShutdown({ server: createServer(), timeoutMs: 0 }),
    ).toThrow();
  });
});
