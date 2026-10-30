// 额度查询错误翻译 + 全新用户的默认单价
//
// 两个都是用户实测踩到的：
//   1. 额度板块直接显示 Python 的原始报错
//      「<urlopen error [Errno 8] nodename nor servname provided, or not known>」
//   2. 别人第一次装，设置里「本地模型单价」整块空白

import test from 'node:test';
import assert from 'node:assert/strict';
import { explainQuotaError } from '../src/core/quota/errors.ts';
import { buildDashboardData } from '../src/core/aggregate.ts';
import { loadPricingNormalized } from '../src/core/pricing.ts';

// ── 错误翻译 ──

test('DNS 解析失败翻译成能听懂的话，不露 Python 原文', () => {
  const raw = '<urlopen error [Errno 8] nodename nor servname provided, or not known>';
  const out = explainQuotaError(raw);
  assert.ok(!out.includes('urlopen'), `不该暴露 Python 原始报错：${out}`);
  assert.ok(!out.includes('Errno'), `不该暴露 errno：${out}`);
  assert.match(out, /域名解析失败|网络/, `要说清是网络问题：${out}`);
  assert.match(out, /代理|网络/, `要给可执行的下一步：${out}`);
});

test('其他常见网络错误同样翻译', () => {
  for (const raw of [
    '<urlopen error [Errno -3] Temporary failure in name resolution>',
    '<urlopen error timed out>',
    'Connection refused',
    'network is unreachable',
  ]) {
    const out = explainQuotaError(raw);
    assert.ok(!/urlopen|Errno/.test(out), `「${raw}」仍暴露原始文本：${out}`);
    assert.match(out, /网络/, `「${raw}」没被识别为网络问题：${out}`);
  }
});

test('HTTP 状态码错误分类正确', () => {
  assert.match(explainQuotaError('HTTP Error 401: Unauthorized'), /API Key/);
  assert.match(explainQuotaError('HTTP Error 429: Too Many Requests'), /限流|频繁/);
  assert.match(explainQuotaError('HTTP Error 502: Bad Gateway'), /服务端/);
});

test('不认识的错误原样返回，不编造提示', () => {
  const raw = 'totally unknown xyz';
  assert.equal(explainQuotaError(raw), raw);
});

// ── 全新用户的默认单价 ──

test('全新用户（无任何日志）也有默认模型单价', async () => {
  const pricing = loadPricingNormalized(7.2);
  const d = await buildDashboardData([], {}, pricing);
  const models = d.settings.models;
  assert.ok(models.length > 0, '全新用户的模型单价列表不该是空的');
  assert.ok(models.length <= 12, '列表应有上限，不能淹没面板');
  for (const m of models) {
    assert.ok(m.name.length > 0);
    assert.ok(Number.isFinite(m.inputCny), `${m.name} 输入单价不是数字`);
    assert.ok(Number.isFinite(m.outputCny), `${m.name} 输出单价不是数字`);
    assert.ok(m.inputCny > 0, `${m.name} 输入单价应大于 0`);
  }
});

test('有日志的老用户：真实使用的模型排在默认值前面', async () => {
  const pricing = loadPricingNormalized(7.2);
  const now = Date.now();
  const ev = (model: string, i: number) => ({
    agent: 'claude-code',
    sessionId: 's1',
    eventId: `e${i}`,
    timestamp: now - 1000,
    provider: 'anthropic',
    model,
    usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 },
  });
  const events = [
    ev('claude-opus-5-5', 1),
    ev('my-private-model', 2),
  ] as never[];
  const d = await buildDashboardData(events, {}, pricing);
  const names = d.settings.models.map((m) => m.name);
  assert.equal(names[0], 'claude-opus-5-5', '在用的模型要排第一');
  assert.ok(names.includes('my-private-model'), '目录外的自建模型也要保留');
  // 默认值补在后面，且不重复
  assert.equal(new Set(names).size, names.length, '不该有重复行');
});

test('用户覆写的模型名一定会出现在列表里', async () => {
  const pricing = loadPricingNormalized(7.2);
  const d = await buildDashboardData([], { priceOverrides: { 'my-model': { input: 1, output: 2 } } }, pricing);
  const names = d.settings.models.map((m) => m.name);
  assert.ok(names.includes('my-model'), `覆写的模型被默认值挤掉了：${names.join(',')}`);
});
