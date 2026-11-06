#!/usr/bin/env node
// 把 web/ 下的看板资源同步到 menubar/src/（Tauri 打包实际读取的目录）。
//
// 背景：web/dashboard.html + web/panel.html 是源文件，menubar/src/dashboard.html
// + menubar/src/index.html 是打包副本。之前靠手拷，改一份漏一份就会发出旧前端。
//
//   node scripts/sync-web-assets.js          同步（web → menubar/src）
//   node scripts/sync-web-assets.js --check  只校验，不一致则以非 0 退出（CI 用）
//
// @inline 内联块：两个 HTML 都要支持 file:// 直开（单文件自包含是硬约束），
// 但看板与面板有部分口径必须一致（如订阅额度的阈值与文案）。共享内容放在
// web/*.js，HTML 里用标记圈出内联区：
//   // @inline quota-shared:start（内容由 sync-web-assets.js 内联，勿手改）
//   ...（与 web/quota-shared.js 逐字一致）...
//   // @inline quota-shared:end
// 编辑点是 .js 文件；本脚本刷新内联区后再做 web → menubar/src 的同步。
//
// ⚠️ 行尾：Windows CI 上 git 按 autocrlf 检出 CRLF，直接逐字节比较会误判
// 过期（v0.4.11 的 Windows 构建就这么挂的）。本脚本内部一律按 LF 归一后
// 比较，写回也用 LF——git 提交时再按仓库规则处理，内容不受影响。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 源 → 打包副本
const MAP = [
  ['web/dashboard.html', 'menubar/src/dashboard.html'],
  ['web/panel.html', 'menubar/src/index.html'],
];

// 可内联的共享块：HTML 里的标记名 → 内容来源文件
const INLINE = [{ name: 'quota-shared', from: 'web/quota-shared.js' }];

/** 统一成行尾 LF 再比较/替换（Windows 检出是 CRLF，见文件头说明） */
const lf = (s) => s.replace(/\r\n/g, '\n');

/**
 * 刷新一段文本里的指定 @inline 区块（纯函数，测试用）。
 * body 与 text 都先归一成 LF；标记行保留，标记之间的内容整段换成 body。
 */
export function refreshInlineText(text, name, body) {
  const t = lf(text);
  const b = lf(body).trim();
  const re = new RegExp(`(// @inline ${name}:start[^\\n]*\\n)[\\s\\S]*?(\\n// @inline ${name}:end)`);
  if (!re.test(t)) throw new Error(`缺少 @inline ${name} 标记区`);
  return t.replace(re, `$1${b}$2`);
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;

  for (const [from, to] of MAP) {
    const src = path.join(ROOT, from);
    const dst = path.join(ROOT, to);
    if (!existsSync(src)) {
      console.error(`✖ 源文件不存在：${from}`);
      process.exit(1);
    }
    let fresh = lf(readFileSync(src, 'utf8'));
    for (const { name, from: inlineFrom } of INLINE) {
      try {
        fresh = refreshInlineText(fresh, name, readFileSync(path.join(ROOT, inlineFrom), 'utf8'));
      } catch (e) {
        console.error(`✖ ${from}：${e instanceof Error ? e.message : e}`);
        process.exit(1);
      }
    }
    // 内联区本身过期：先看源文件要不要回写
    if (fresh !== lf(readFileSync(src, 'utf8'))) {
      if (check) {
        console.error(`✖ ${from} 的 @inline 区块过期（共享 .js 已更新，未重新内联）`);
        stale++;
      } else {
        writeFileSync(src, fresh);
        console.log(`→ 已刷新内联区块 ${from}`);
      }
    }
    const same = existsSync(dst) && fresh === lf(readFileSync(dst, 'utf8'));
    if (same) {
      console.log(`✓ 一致 ${to}`);
      continue;
    }
    if (check) {
      console.error(`✖ 过期 ${to}（源 ${from} 已更新，未同步）`);
      stale++;
    } else {
      writeFileSync(dst, fresh);
      console.log(`→ 已同步 ${from} → ${to}`);
    }
  }

  if (stale > 0) {
    console.error('\n打包资源与源不一致，跑 `npm run sync:assets` 后重试。');
    process.exit(1);
  }
}

// 被测试 import 时不执行同步逻辑
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
