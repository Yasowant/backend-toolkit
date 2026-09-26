import type { Request, RequestHandler } from 'express';
import { httpErrors } from '../errors/index.js';
/** Application-resolved identity; authentication belongs to your application. */
export interface Principal {
  roles?: readonly string[];
  permissions?: readonly string[];
}
/** Declarative access requirements. All is the safe default; any is explicit. */
export interface AccessPolicy {
  roles?: readonly string[];
  permissions?: readonly string[];
  mode?: 'all' | 'any';
}
/** Evaluate roles and permissions without framework dependencies. Empty policies deny access. */
export function hasAccess(principal: Principal, policy: AccessPolicy): boolean {
  const checks = [
    ...(policy.roles ?? []).map(
      (role) => principal.roles?.includes(role) ?? false,
    ),
    ...(policy.permissions ?? []).map(
      (permission) => principal.permissions?.includes(permission) ?? false,
    ),
  ];
  return (
    checks.length > 0 &&
    (policy.mode === 'any' ? checks.some(Boolean) : checks.every(Boolean))
  );
}
/** Authorize a request using req.user or a custom asynchronous identity resolver. */
export function authorize(
  options: AccessPolicy & {
    getPrincipal?: (
      req: Request,
    ) => Principal | undefined | null | Promise<Principal | undefined | null>;
  },
): RequestHandler {
  if (!(options.roles?.length || options.permissions?.length))
    throw new TypeError(
      'Authorization requires at least one role or permission',
    );
  return (req, _res, next) => {
    Promise.resolve()
      .then(async () => {
        const principal = await (options.getPrincipal
          ? options.getPrincipal(req)
          : (req as Request & { user?: Principal }).user);
        if (!principal) throw httpErrors.unauthorized();
        if (!hasAccess(principal, options)) throw httpErrors.forbidden();
      })
      .then(
        () => next(),
        (error: unknown) =>
          next(
            error instanceof Error
              ? error
              : new Error('Principal resolution failed', { cause: error }),
          ),
      );
  };
}
