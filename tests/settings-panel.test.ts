// 设置面板的数据设置 —— 用户实测报告的问题，逐条锁住。
//
// 这些 bug 的共同点：界面上「点了没反应」，控制台才有错，
// 用户完全无从判断。测试盯的是可静态检查的调用形态。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dash = readFileSync(resolve(ROOT, 'web/dashboard.html'), 'utf8');

test('「添加自定义平台」不能和被 .addrow 循环重复绑定', () => {
  // 曾经：mAddCustom 与 mTestKeys 也带 .addrow 类，被 $$(".addrow") 循环
  // 一起绑定，点击时执行 settings[undefined].push 直接抛 TypeError。
  const loop = dash.match(/\$\$\("\.addrow"\)\.forEach\(function\(b\)\{[\s\S]*?\n\}\);/);
  assert.ok(loop, '找不到 .addrow 绑定循环');
  assert.match(
    loop![0],
    /if\(!b\.dataset\.add\s*\)\s*return/,
    '.addrow 循环必须先排除没有 data-add 的按钮',
  );
});

test('自定义平台不用 prompt()（Tauri WebView 会静默拦截）', () => {
  // 被拦截时表现为「点了完全没反应」，最难排查
  const fn = dash.match(/function addCustomEndpoint\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 addCustomEndpoint');
  assert.ok(
    !/\bprompt\s*\(/.test(fn![0]),
    'addCustomEndpoint 里不应再用 prompt()，应改为内联表单',
  );
  assert.match(fn![0], /cxOk|cxName/, '应渲染内联表单字段');
});

test('测试连接不能把 {keys, customs} 整个塞进 keys', () => {
  // 曾经：body 是 {keys: {keys: {...}, customs: []}}，多包一层，
  // 服务端 keys?.[id] 永远是 undefined，所有平台都报「未配置」
  const fn = dash.match(/async function testKeys\(\)\{[\s\S]*?\n\}\n/);
  assert.ok(fn, '找不到 testKeys');
  const body = fn![0];
  assert.ok(
    !/JSON\.stringify\(\{\s*keys:\s*collectKeys\(\)/.test(body),
    '不能直接把 collectKeys() 结果当成 keys',
  );
  assert.match(body, /collected\.keys/, '应取 .keys 后再传');
});

test('测试连接要同时支持 Tauri 与浏览器两种宿主', () => {
  const fn = dash.match(/async function testKeys\(\)\{[\s\S]*?\n\}\n/);
  assert.ok(fn);
  const body = fn![0];
  assert.match(body, /inTauri\(\)/, '必须区分宿主');
  assert.match(body, /quota_test/, '桌面端走 Tauri 命令');
  assert.match(body, /\/api\/quota\/test/, '浏览器走本地 serve');
});

test('自动压缩阈值输入框以「千 tokens」为单位，不能被原始 token 数污染', () => {
  // 曾经：String(Math.round((x || 100000/1000) || 100))
  // 运算符优先级导致 x 存在时直接把 150000 塞进输入框，
  // 用户一保存就变成 150000 * 1000 = 1.5 亿
  const line = dash.match(/\$\("#mCompactK"\)\.value\s*=\s*([^;]+);/);
  assert.ok(line, '找不到阈值输入框赋值');
  const expr = line![1];
  assert.ok(
    /\/\s*1000/.test(expr),
    `赋值表达式应把 token 数除以 1000 转成千单位：${expr}`,
  );
});

test('阈值换算结果正确（回归用例）', () => {
  const toThousand = (tokens: number | undefined) =>
    String(Math.round(((tokens || 100000) as number) / 1000));
  assert.equal(toThousand(undefined), '100');
  assert.equal(toThousand(150000), '150');
  assert.equal(toThousand(50000), '50');
});

test('订阅登记区分数据来源，自动来源不可编辑', () => {
  const block = dash.match(/\$\("#mSubs"\)\.innerHTML=[\s\S]*?\n  \}\)\.join\(""\);/);
  assert.ok(block, '找不到订阅渲染');
  const body = block![0];
  assert.match(body, /origin/, '要按 origin 区分');
  assert.match(body, /api.*CC Switch|ORIGIN_TAG/, '要有来源标签');
  assert.ok(
    /!==?\s*['"]manual['"]/.test(body) || /origin\s*!==?\s*['"]manual['"]/.test(body),
    '非 manual 来源应走只读分支',
  );
});

test('保存订阅时跳过自动来源，避免写回后重复计费', () => {
  const save = dash.match(/settings\.subs\.forEach\([\s\S]*?\}\);/);
  assert.ok(save, '找不到订阅保存');
  assert.match(
    save![0],
    /origin/,
    '保存时应判断 origin，只把 manual 的写回 config',
  );
});

// ── 0.4.10 修的三个 bug ──

test('删除平台时清掉 masked 标记，行才会从列表移除', () => {
  // 之前只清 value 不清 masked，而 renderKeyRows 靠 masked 判断「已添加」，
  // 导致点了 × 行还在
  const fn = dash.match(/\[data-keyclear\][\s\S]*?\}\);/);
  assert.ok(fn, '找不到删除处理');
  assert.match(fn![0], /k\.masked\s*=\s*null/, '删除时必须清 masked');
  assert.match(fn![0], /k\.added\s*=\s*false/, '删除时必须移除 added');
});

test('保存提示常驻，不一闪而过', () => {
  // 之前 setTimeout 1600ms 就消失，用户分不清存没存上
  const fn = dash.match(/function showHint\([^)]*\)\{[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 showHint');
  assert.match(fn![0], /duration>0/, '常驻支持（duration=0 时不自动消失）');
  assert.match(fn![0], /classList\.add\(ok===false\?"err":"ok"\)/, '要区分成功和失败');
});

test('桌面端 quota_test 识别旧版 CLI 不报 JSON 解析错', () => {
  // 旧版 CLI 没有 quota-test 子命令，会输出「用法：...」纯文本，
  // 第一个字符「用」让 JSON.parse 崩成 Unrecognized token
  const rs = readFileSync(resolve(ROOT, 'menubar/src-tauri/src/main.rs'), 'utf8');
  assert.match(rs, /starts_with\('\{'\)/, '要识别非 JSON 输出');
  assert.match(rs, /命令行版本过旧/, '要给升级提示');
});
