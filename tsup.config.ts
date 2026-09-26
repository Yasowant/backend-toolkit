import { defineConfig } from 'tsup';
import { readdirSync } from 'node:fs';
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ...Object.fromEntries(
      readdirSync('src', { withFileTypes: true })
        .filter((x) => x.isDirectory())
        .map((x) => [`${x.name}/index`, `src/${x.name}/index.ts`]),
    ),
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  external: ['express', 'ws'],
  target: 'node22',
});
