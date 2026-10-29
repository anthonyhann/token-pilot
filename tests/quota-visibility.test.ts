// 订阅额度板块的显示规则 —— 两个前端必须一致。
//
// 用户明确要求的规则：没有任何可监控平台时，整块隐藏，不显示「暂未检测到」。
// 空壳标题既占位置又没有信息量，用户也做不了什么。
//
// 这条规则容易在改版时被无意破坏（比如有人为了「友好」又塞回一句提示），
// 所以用测试盯住两处源码：既不能残留空态文案，也必须有隐藏分支。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const panel = readFileSync(resolve(ROOT, 'web/panel.html'), 'utf8');
const dash = readFileSync(resolve(ROOT, 'web/dashboard.html'), 'utf8');

test('两处都要求：无数据时隐藏，而不是显示空态文案', () => {
  // 不允许残留「暂未检测到可监控的平台」这类空态占位
  for (const [name, src] of [['面板', panel], ['看板', dash]] as const) {
    assert.ok(
      !src.includes('暂未检测到可监控的平台'),
      `${name} 里仍有空态文案，应改为整块隐藏`,
    );
  }
});

test('面板：providers 为空时把标题和容器都设为 none', () => {
  // 找到 renderQuota 里的空数据分支
  const i = panel.indexOf('function renderQuota');
  assert.ok(i > 0, '面板应有 renderQuota');
  const body = panel.slice(i, i + 900);
  assert.match(body, /!provs\.length/, '要有「没有平台」的判定');
  assert.match(body, /title\.style\.display\s*=\s*"none"/, '标题应隐藏');
  assert.match(body, /box\.style\.display\s*=\s*"none"/, '容器应隐藏');
});

test('看板：providers 为空时隐藏整个 section', () => {
  const i = dash.indexOf('function renderQuota');
  assert.ok(i > 0, '看板应有 renderQuota');
  const body = dash.slice(i, i + 700);
  assert.match(body, /quotaSection/, '要操作外层 section');
  assert.match(body, /sec\.style\.display\s*=\s*'none'/, '整块应隐藏');
});

test('看板 section 默认隐藏，避免首帧闪一下空壳', () => {
  const m = dash.match(/id="quotaSection"[^>]*style="([^"]*)"/);
  assert.ok(m, 'quotaSection 应有内联样式');
  assert.match(m![1], /display:\s*none/, '初始应为 none，拿到数据再显示');
});

test('面板容器默认隐藏同理', () => {
  assert.match(panel, /id="quotaTitle"[^>]*style="display:none"/, 'quotaTitle 初始隐藏');
  assert.match(panel, /id="quotaBox"[^>]*style="display:none"/, 'quotaBox 初始隐藏');
});

test('打包副本已同步（Tauri 打包读的是 menubar/src）', () => {
  for (const [src, dst] of [
    ['web/dashboard.html', 'menubar/src/dashboard.html'],
    ['web/panel.html', 'menubar/src/index.html'],
  ]) {
    assert.equal(
      readFileSync(resolve(ROOT, dst), 'utf8'),
      readFileSync(resolve(ROOT, src), 'utf8'),
      `${dst} 与 ${src} 不一致，跑 npm run sync:assets`,
    );
  }
});
