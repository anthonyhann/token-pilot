// @inline 共享块的防漂移测试 —— 盯住「改一处忘一处」这个历史 bug。
//
// 看板（dashboard.html）与面板（panel.html）都是单文件自包含 HTML
// （要支持 file:// 直开），共享口径不能做成外部 JS，只能内联。
// 唯一编辑点是 web/quota-shared.js，由 scripts/sync-web-assets.js 内联进
// 两个 HTML 的标记区。这里验证：内联区必须与源文件逐字一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshInlineText } from '../scripts/sync-web-assets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = readFileSync(resolve(ROOT, 'web/quota-shared.js'), 'utf8').trim();

function inlineRegion(rel: string): string {
  const text = readFileSync(resolve(ROOT, rel), 'utf8');
  const m = text.match(/\/\/ @inline quota-shared:start[^\n]*\n([\s\S]*?)\n\/\/ @inline quota-shared:end/);
  assert.ok(m, `${rel} 缺少 @inline quota-shared 标记区`);
  return m![1].trim();
}

for (const rel of ['web/dashboard.html', 'web/panel.html']) {
  test(`${rel} 的 @inline 区与 web/quota-shared.js 逐字一致`, () => {
    assert.equal(
      inlineRegion(rel),
      shared,
      `${rel} 的共享口径过期：编辑点是 web/quota-shared.js，改完跑 npm run sync:assets`,
    );
  });
}

test('两个页面都用共享口径，不各自定义阈值/文案', () => {
  for (const rel of ['web/dashboard.html', 'web/panel.html']) {
    const text = readFileSync(resolve(ROOT, rel), 'utf8');
    // 本地重复定义是漂移的源头：出现过就说明有人绕开了共享块
    for (const dup of ['function qBarColor', 'function qResetText', 'function qResets', 'var QSRC=']) {
      assert.ok(!text.includes(dup), `${rel} 残留本地定义 ${dup}，应改用 @inline 共享块`);
    }
    assert.ok(text.includes('tpqResetText'), `${rel} 应使用共享的 tpqResetText`);
  }
});

// ── CRLF 回归：v0.4.11 的 Windows 构建就因为行尾误判挂过 ──
// Windows CI 上 git 按 autocrlf 把文件检出成 CRLF，逐字节比较会把
// 内容一致的文件误判成「过期」，必须按 LF 归一后再比较。

test('CRLF 检出的文件不会被误判为过期', () => {
  const lfHtml = '<script>\n// @inline quota-shared:start（测试）\nvar A=1;\n// @inline quota-shared:end\n</script>\n';
  const crlfHtml = lfHtml.replace(/\n/g, '\r\n');
  const body = 'var A=1;\n';
  // CRLF 的 HTML + LF 的共享源：刷新后应等于 LF 版本（即「内容一致」）
  assert.equal(refreshInlineText(crlfHtml, 'quota-shared', body), refreshInlineText(lfHtml, 'quota-shared', body));
  // 已经是最新内容的 CRLF 文件，刷新后不应再变化（幂等）
  const fresh = refreshInlineText(lfHtml, 'quota-shared', body);
  assert.equal(refreshInlineText(fresh.replace(/\n/g, '\r\n'), 'quota-shared', body), fresh);
});

test('缺标记区时报错而不是静默跳过', () => {
  assert.throws(() => refreshInlineText('<html>no markers</html>', 'quota-shared', 'x'), /缺少 @inline/);
});
