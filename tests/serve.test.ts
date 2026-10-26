// serve 层纯函数测试：数据注入标记 + 资源读取（回归：bake 曾把 HTML 当文件名写）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { injectData, readWebAsset } from '../src/cli/serve.ts';

test('injectData：恰好替换注入标记一次，且内容可 JSON.parse', () => {
  const html = '<html><script>window.__TP_DATA__=null;</script></html>';
  const out = injectData(html, { generatedAt: 123 } as never);
  assert.ok(!out.includes('__TP_DATA__=null'));
  const m = out.match(/window\.__TP_DATA__=(\{.*?\});/);
  assert.ok(m, '注入标记未被替换');
  assert.equal(JSON.parse(m![1]).generatedAt, 123);
});

test('injectData：HTML 中的 </script> 会被转义，不破坏文档结构', () => {
  const html = '<script>window.__TP_DATA__=null;</script>';
  const payload = { generatedAt: 1, note: '</script><script>alert(1)</script>' } as never;
  const out = injectData(html, payload);
  assert.ok(!out.includes('</script><script>alert'), 'XSS 注入必须被 \\u003c 转义');
});

test('readWebAsset：dashboard.html / panel.html 存在且非空', () => {
  for (const name of ['dashboard.html', 'panel.html']) {
    const html = readWebAsset(name);
    assert.ok(html && html.length > 10_000, `${name} 缺失或为空`);
    assert.ok(html.includes('window.__TP_DATA__=null;'), `${name} 缺注入标记`);
  }
});

// 回归：package.json 的 files 曾漏掉 web/，导致 npm 包装上后
// serve/dash 直接报「web/dashboard.html 不存在」，用户拿不到看板。
test('打包配置：files 必须包含 web（否则 npm 包里没有看板 HTML）', () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files?: string[] };
  assert.ok(Array.isArray(pkg.files), 'package.json 缺 files 字段');
  assert.ok(pkg.files!.includes('web'), 'files 必须包含 web，否则看板页面不会被打进 npm 包');
});
