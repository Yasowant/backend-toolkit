import { paginationMeta, type PaginationOptions } from '../pagination/index.js';
/** Plain response envelopes; the caller controls HTTP status and headers. */
export const ApiResponse = {
  success<T>(data: T, message = 'Success') {
    return { success: true as const, message, data };
  },
  error(message: string, code = 'API_ERROR') {
    return { success: false as const, message, error: { code } };
  },
  paginated<T>(
    data: T[],
    total: number,
    options: PaginationOptions = {},
    message = 'Success',
  ) {
    return {
      success: true as const,
      message,
      data,
      meta: paginationMeta(total, options),
    };
  },
};
