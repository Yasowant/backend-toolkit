import process from 'node:process';
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'backend-toolkit-consumer-'));
const npm = (args, cwd = root) =>
  execFileSync('npm', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(tmpdir(), 'backend-toolkit-npm-cache'),
    },
  });
try {
  npm(['run', 'build']);
  const packed = JSON.parse(
    npm([
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      temporary,
    ]),
  );
  const meta = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const file of packed[0].files)
    if (!/^(dist\/|README.md$|LICENSE$|package.json$)/.test(file.path))
      throw new Error(`Unexpected packed file: ${file.path}`);
  writeFileSync(
    join(temporary, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  npm(
    [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      join(temporary, packed[0].filename),
    ],
    temporary,
  );
  for (const key of Object.keys(meta.exports)) {
    const spec = meta.name + (key === '.' ? '' : key.slice(1));
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(spec)})`],
      { cwd: temporary },
    );
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(spec)})`], {
      cwd: temporary,
    });
  }
  const source = `import {retry,ApiError,validateEnv,env,createReliableSocket} from '@yasowant/backend-toolkit';\nimport {paginate} from '@yasowant/backend-toolkit/pagination';\nconst config=validateEnv({PORT:env.number});\nconst n:number=config.PORT;\nvoid retry(async()=>n);\nnew ApiError(400,'bad');\npaginate();\ncreateReliableSocket({url:'ws://localhost'});\n`;
  writeFileSync(join(temporary, 'consumer.mts'), source);
  writeFileSync(join(temporary, 'consumer.cts'), source);
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      join(temporary, 'consumer.mts'),
      join(temporary, 'consumer.cts'),
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  console.log(
    `Verified ${Object.keys(meta.exports).length} exports in ESM and CommonJS, declarations, and package allowlist.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
