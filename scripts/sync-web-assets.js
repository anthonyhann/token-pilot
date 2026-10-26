#!/usr/bin/env node
// 把 web/ 下的看板资源同步到 menubar/src/（Tauri 打包实际读取的目录）。
//
// 背景：web/dashboard.html + web/panel.html 是源文件，menubar/src/dashboard.html
// + menubar/src/index.html 是打包副本。之前靠手拷，改一份漏一份就会发出旧前端。
//
//   node scripts/sync-web-assets.js          同步（web → menubar/src）
//   node scripts/sync-web-assets.js --check  只校验，不一致则以非 0 退出（CI 用）

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 源 → 打包副本
const MAP = [
  ['web/dashboard.html', 'menubar/src/dashboard.html'],
  ['web/panel.html', 'menubar/src/index.html'],
];

const check = process.argv.includes('--check');
let stale = 0;

for (const [from, to] of MAP) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  if (!existsSync(src)) {
    console.error(`✖ 源文件不存在：${from}`);
    process.exit(1);
  }
  const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst));
  if (same) {
    console.log(`✓ 一致 ${to}`);
    continue;
  }
  if (check) {
    console.error(`✖ 过期 ${to}（源 ${from} 已更新，未同步）`);
    stale++;
  } else {
    writeFileSync(dst, readFileSync(src));
    console.log(`→ 已同步 ${from} → ${to}`);
  }
}

if (stale > 0) {
  console.error('\n打包资源与源不一致，跑 `npm run sync:assets` 后重试。');
  process.exit(1);
}
