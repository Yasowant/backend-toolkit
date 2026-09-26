/** Pagination inputs, with a hard cap controlled by the application. */
export interface PaginationOptions {
  page?: number;
  limit?: number;
  maxLimit?: number;
}
/** Validated bounds for array or database pagination. */
export function paginate({
  page = 1,
  limit = 20,
  maxLimit = 100,
}: PaginationOptions = {}) {
  for (const [key, value] of Object.entries({ page, limit, maxLimit }))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${key} must be a positive safe integer`);
  limit = Math.min(limit, maxLimit);
  const skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip))
    throw new RangeError('Pagination offset exceeds safe integer range');
  return { page, limit, skip };
}
/** Create complete navigation metadata. Empty datasets have zero pages. */
export function paginationMeta(total: number, options: PaginationOptions = {}) {
  if (!Number.isSafeInteger(total) || total < 0)
    throw new RangeError('total must be a non-negative safe integer');
  const { page, limit } = paginate(options);
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0,
  };
}
/** Minimal structural contract supported by Mongoose queries. */
export interface PaginationQuery<T> {
  skip(value: number): PaginationQuery<T>;
  limit(value: number): PaginationQuery<T>;
  exec(): Promise<T[]>;
}
/** Execute a caller-filtered query and matching count without importing Mongoose. Use a stable sort. */
export async function paginateMongoose<T>(
  query: PaginationQuery<T>,
  count: () => Promise<number>,
  options: PaginationOptions = {},
) {
  const bounds = paginate(options);
  const [data, total] = await Promise.all([
    query.skip(bounds.skip).limit(bounds.limit).exec(),
    count(),
  ]);
  return { data, meta: paginationMeta(total, options) };
}
