/** A synchronous environment parser. Throw on invalid input. */
export type EnvParser<T> = (value: string | undefined) => T;
/** Startup failure reporting invalid keys only, never their values. */
export class EnvValidationError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`Invalid or missing environment variables: ${keys.join(', ')}`);
    this.name = 'EnvValidationError';
  }
}
/** Built-in strict parsers. Wrap a parser with env.default for optional values. */
export const env = {
  string: ((value) => {
    if (value === undefined || value.trim() === '') throw new Error('Required');
    return value;
  }) as EnvParser<string>,
  number: ((value) => {
    if (
      value === undefined ||
      value.trim() === '' ||
      !Number.isFinite(Number(value))
    )
      throw new Error('Expected number');
    return Number(value);
  }) as EnvParser<number>,
  boolean: ((value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('Expected true or false');
  }) as EnvParser<boolean>,
  default<T>(parser: EnvParser<T>, fallback: T): EnvParser<T> {
    return (value) => (value === undefined ? fallback : parser(value));
  },
};
/** Validate all keys and infer the resulting configuration type. Throws before startup on failure. */
export function validateEnv<S extends Record<string, EnvParser<unknown>>>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): { [K in keyof S]: ReturnType<S[K]> } {
  const result: Record<string, unknown> = Object.create(null);
  const failures: string[] = [];
  for (const [key, parser] of Object.entries(schema)) {
    try {
      result[key] = parser(source[key]);
    } catch {
      failures.push(key);
    }
  }
  if (failures.length) throw new EnvValidationError(failures);
  return result as { [K in keyof S]: ReturnType<S[K]> };
}
