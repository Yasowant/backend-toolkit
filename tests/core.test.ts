import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  ApiError,
  httpErrors,
  errorHandler,
  asyncHandler,
} from '../src/index.js';
describe('errors and async routes', () => {
  it('validates status and retains cause', () => {
    const cause = new Error('db secret');
    expect(new ApiError(400, 'safe', { cause }).cause).toBe(cause);
    expect(() => new ApiError(200, 'bad')).toThrow(RangeError);
  });
  it('creates standard HTTP errors', () => {
    expect(Object.values(httpErrors).map((fn) => fn().statusCode)).toEqual([
      400, 401, 403, 404, 409, 422, 429, 500, 503,
    ]);
  });
  it('forwards async and sync failures and hides internals', async () => {
    const app = express();
    app.get(
      '/async',
      asyncHandler(async () => {
        throw httpErrors.badRequest('Invalid input');
      }),
    );
    app.get(
      '/sync',
      asyncHandler(() => {
        throw new Error('database password');
      }),
    );
    app.use(errorHandler());
    expect((await request(app).get('/async')).body.message).toBe(
      'Invalid input',
    );
    const res = await request(app).get('/sync');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });
  it('only includes diagnostics when opted in', async () => {
    const app = express();
    app.get(
      '/',
      asyncHandler(() => {
        throw new Error('debug detail');
      }),
    );
    app.use(errorHandler({ development: true }));
    expect((await request(app).get('/')).body.error.debug.message).toBe(
      'debug detail',
    );
  });
  it('passes successful requests', async () => {
    const app = express();
    app.get(
      '/',
      asyncHandler(async (_req, res) => res.json({ ok: true })),
    );
    expect((await request(app).get('/')).body).toEqual({ ok: true });
  });
});
