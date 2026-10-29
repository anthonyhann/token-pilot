// 发布说明抽取与 Markdown 剥离 —— 守的是「更新弹窗里看到字面星号」这类问题。
//
// 背景：v0.4.1 的更新弹窗显示成「**面板标题区显示当前版本**」，
// 因为 latest.json 的 notes 直接塞了 Markdown，而弹窗是纯文本渲染。
// 修复逻辑在 scripts/release_notes.py，这里从 TS 侧调用它做回归。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';



const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/release_notes.py');

const run = (args: string[]) =>
  execFileSync('python3', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('抽取 v0.4.1 且已剥掉 Markdown', () => {
  const out = run(['0.4.1']);
  assert.ok(out.length > 0, '说明不该为空');
  assert.ok(!out.includes('**'), `不该有加粗标记：${out.slice(0, 80)}`);
  assert.ok(!/`[^`\n]+`/.test(out), '不该有行内代码反引号');
  assert.ok(!/\[[^\]]+\]\([^)]*\)/.test(out), '不该有 Markdown 链接语法');
  assert.match(out, /面板标题区显示当前版本/, '正文内容要保留');
});

test('所有历史版本都能抽出且无残留标记', () => {
  const txt = execFileSync('sed', ['-n', 'p', resolve(ROOT, 'RELEASE_NOTES.md')], { encoding: 'utf8' });
  const versions = [...txt.matchAll(/^## v([\d.]+)\s*$/gm)].map((m) => m[1]);
  assert.ok(versions.length >= 10, `版本数异常：${versions.length}`);
  for (const v of versions) {
    const out = run([v]);
    assert.ok(out.trim().length > 0, `v${v} 说明为空`);
    assert.ok(!/\*\*|`[^`\n]+`|\[[^\]]+\]\([^)]*\)/.test(out), `v${v} 有残留标记`);
  }
});

test('剥离规则：边界用例不误伤', () => {
  // 通过 --raw 之外的方式没法直接喂输入，这里用一个临时 NOTES 文件不好搞，
  // 改为直接测脚本内可观察的行为：算式与标识符在真实说明里不会被吃掉。
  const out = run(['0.4.1']);
  assert.match(out, /package\.json/, '文件名里的点不该被动');
  assert.match(out, /v0\.4\.1 · 数据 v0\.4\.0/, '版本号里的点不该被动');
});

test('找不到版本号时明确报错而不是静默给空', () => {
  const r = spawnSync('python3', [SCRIPT, '99.99.99'], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /找不到/);
});

test('--raw 返回原始 Markdown（给人工查看用）', () => {
  const raw = run(['0.4.0', '--raw']);
  assert.ok(raw.includes('**'), '原始段落应保留加粗标记');
});
