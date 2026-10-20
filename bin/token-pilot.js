#!/usr/bin/env node
// token-pilot 全局入口：用 --experimental-strip-types 直接跑 TS，无需先 build
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, '../src/cli/index.ts');

const r = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(r.status ?? 0);
