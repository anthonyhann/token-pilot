#!/usr/bin/env node
// token-pilot 全局入口：优先跑编译产物 dist/（npm 包形态）；仓库内开发回退 tsx
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(__dirname, '../dist/cli/index.js');
const srcEntry = path.resolve(__dirname, '../src/cli/index.ts');

let r;
if (existsSync(distEntry)) {
  r = spawnSync(process.execPath, [distEntry, ...process.argv.slice(2)], { stdio: 'inherit' });
} else {
  r = spawnSync('npx', ['tsx', srcEntry, ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32' });
}
process.exit(r.status ?? 0);
