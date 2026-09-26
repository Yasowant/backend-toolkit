import type { ErrorRequestHandler } from 'express';

/** Options for a deliberate HTTP failure. Only expose safe, public messages. */
export interface ApiErrorOptions {
  cause?: unknown;
  code?: string;
  expose?: boolean;
}
/** An HTTP error that retains its original cause without serializing it. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;
  constructor(
    statusCode: number,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)
      throw new RangeError('statusCode must be an integer from 400 to 599');
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code ?? 'API_ERROR';
    this.expose = options.expose ?? statusCode < 500;
  }
}
/** Factories for standard HTTP failures. */
export const httpErrors = {
  badRequest: (message = 'Bad request', options?: ApiErrorOptions) =>
    new ApiError(400, message, options),
  unauthorized: (message = 'Unauthorized', options?: ApiErrorOptions) =>
    new ApiError(401, message, options),
  forbidden: (message = 'Forbidden', options?: ApiErrorOptions) =>
    new ApiError(403, message, options),
  notFound: (message = 'Not found', options?: ApiErrorOptions) =>
    new ApiError(404, message, options),
  conflict: (message = 'Conflict', options?: ApiErrorOptions) =>
    new ApiError(409, message, options),
  unprocessableEntity: (
    message = 'Unprocessable entity',
    options?: ApiErrorOptions,
  ) => new ApiError(422, message, options),
  tooManyRequests: (message = 'Too many requests', options?: ApiErrorOptions) =>
    new ApiError(429, message, options),
  internal: (message = 'Internal server error', options?: ApiErrorOptions) =>
    new ApiError(500, message, options),
  unavailable: (message = 'Service unavailable', options?: ApiErrorOptions) =>
    new ApiError(503, message, options),
};
/** Safe-by-default error middleware. Development diagnostics require explicit opt-in. */
export function errorHandler(
  options: { development?: boolean } = {},
): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const known = error instanceof ApiError;
    const message =
      known && error.expose ? error.message : 'Internal server error';
    res.status(known ? error.statusCode : 500).json({
      success: false,
      message,
      error: {
        code: known && error.expose ? error.code : 'INTERNAL_ERROR',
        ...(options.development && error instanceof Error
          ? { debug: { message: error.message, stack: error.stack } }
          : {}),
      },
      ...(typeof res.locals.requestId === 'string'
        ? { requestId: res.locals.requestId }
        : {}),
    });
  };
}
