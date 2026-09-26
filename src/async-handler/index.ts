import type { Request, Response, NextFunction, RequestHandler } from 'express';
/** Wrap sync/async Express routes, forwarding throws and rejections to next. */
export function asyncHandler(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(next);
  };
}
