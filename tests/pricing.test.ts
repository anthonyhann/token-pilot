// 定价层测试：匹配策略 + 成本核算不重复计费 + 覆写换算

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costOf, cacheSavingsUsd, loadPricing, loadPricingWithOverrides } from '../src/core/pricing.ts';

const usage = (i: number, o: number, cr: number, cw: number) => ({
  inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cw,
  totalTokens: i + o + cr + cw,
});

test('精确匹配', () => {
  const p = priceFor('claude-sonnet-4-6');
  assert.equal(p.input, 3.0);
  assert.equal(p.output, 15.0);
  assert.equal(p.cacheRead, 0.3);
});

test('大小写归一：MiniMax-M3 命中 minimax-m3', () => {
  const p = priceFor('MiniMax-M3');
  assert.equal(p.provider, 'minimax');
});

test('前缀匹配：deepseek-v4.1-flash-20260601 → deepseek-flash（分时，offpeak 平铺）', () => {
  const p = priceFor('deepseek-v4.1-flash-20260601');
  assert.equal(p.provider, 'deepseek');
  assert.ok(p.offpeak, '应带分时表');
  assert.equal(p.offpeak!.input, 1.0);   // CNY 目录价（未归一）
});

test('横杠别名：deepseek-v4-1-flash 不掉进 fallback', () => {
  const p = priceFor('deepseek-v4-1-flash');
  assert.equal(p.provider, 'deepseek');
});

test('未知模型走 fallback', () => {
  const p = priceFor('some-unknown-model');
  assert.equal(p.input, 1.0);
  assert.equal(p.output, 5.0);
});

test('costOf 分项独立计价：缓存不按全价重复计', () => {
  // sonnet: in 3 / out 15 / cacheRead 0.3 / cacheCreation 3.75
  const c = costOf('claude-sonnet-4-6', usage(1_000_000, 100_000, 10_000_000, 1_000_000));
  assert.ok(Math.abs(c.inputUsd - 3.0) < 1e-9);
  assert.ok(Math.abs(c.outputUsd - 1.5) < 1e-9);
  assert.ok(Math.abs(c.cacheReadUsd - 3.0) < 1e-9);       // 10M × 0.3 = $3（若按全价 input 算会是 $30）
  assert.ok(Math.abs(c.cacheCreationUsd - 3.75) < 1e-9);
  assert.ok(Math.abs(c.totalUsd - 11.25) < 1e-9);
});

test('缺 cacheRead 价的模型按 input×0.1 折算', () => {
  const t = loadPricing();
  const noCache = Object.entries(t.models).find(([, v]) => v.cacheRead === undefined);
  if (noCache) {
    const c = costOf(noCache[0], usage(0, 0, 1_000_000, 0));
    assert.ok(Math.abs(c.cacheReadUsd - noCache[1].input * 0.1) < 1e-9);
  }
});

test('cacheSavingsUsd = cacheRead × (input − cacheRead 价)', () => {
  // sonnet: (3.0 − 0.3) × 10M = $27
  const s = cacheSavingsUsd('claude-sonnet-4-6', 10_000_000);
  assert.ok(Math.abs(s - 27.0) < 1e-9);
});

test('用户覆写（¥/M）按汇率折算合并', () => {
  const t = loadPricingWithOverrides({ 'my-model': { input: 7.2, output: 36, cacheRead: 0.72 } }, 7.2);
  const p = priceFor('my-model', t);
  assert.ok(Math.abs(p.input - 1.0) < 1e-9);
  assert.ok(Math.abs(p.output - 5.0) < 1e-9);
  assert.ok(Math.abs((p.cacheRead ?? 0) - 0.1) < 1e-9);
});
