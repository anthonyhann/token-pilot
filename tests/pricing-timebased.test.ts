// 分时定价 + 币种归一 + 别名 测试

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepSeekPeak, costOf, priceFor, loadPricingNormalized, loadPricingWithOverrides } from '../src/core/pricing.ts';

const U = (i: number, o: number, cr = 0, cw = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cw, totalTokens: i + o + cr + cw });

test('DeepSeek 高峰：周四 10:00 北京时间 = peak', () => {
  // 2026-10-22 是周四；10:00 CST = 02:00 UTC
  const t = Date.UTC(2026, 9, 22, 2, 0, 0);
  assert.equal(isDeepSeekPeak(t), true);
});

test('DeepSeek 空闲：周四 12:30（午间）/ 周六 / 国庆 = offpeak', () => {
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 22, 4, 30)), false);  // 周四 12:30 CST
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 24, 10, 0)), false);  // 周六
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 1, 2, 0)), false);    // 国庆 10-01
});

test('分时计价：同量不同价', () => {
  const t = loadPricingNormalized(7.2);
  const peak = costOf('deepseek-flash', U(1_000_000, 100_000), t, Date.UTC(2026, 9, 22, 2, 0));
  const off = costOf('deepseek-flash', U(1_000_000, 100_000), t, Date.UTC(2026, 9, 22, 4, 30));
  // peak: 2/8 元; offpeak: 1/4 元 → peak = 2× off
  assert.ok(Math.abs(peak.totalUsd / off.totalUsd - 2) < 0.01, `比值 ${peak.totalUsd / off.totalUsd}`);
});

test('别名：deepseek-v4.1-flash 命中 deepseek-flash 的分时价', () => {
  const t = loadPricingNormalized(7.2);
  const p = priceFor('deepseek-v4.1-flash', t);
  assert.ok(p.peak, '别名应解析到分时表');
  assert.equal(p.provider, 'deepseek');
});

test('CNY 归一：glm-5.3 按汇率折算成 USD', () => {
  const t = loadPricingNormalized(7.2);
  const p = priceFor('glm-5.3', t);
  assert.ok(Math.abs(p.input - 8.0 / 7.2) < 0.001, `glm-5.3 input $${p.input}`);
});

test('人工覆写优先于官方目录价', () => {
  const t = loadPricingWithOverrides({ 'glm-5.3': { input: 7.2, output: 36, cacheRead: 0.72 } }, 7.2);
  const p = priceFor('glm-5.3', t);
  assert.ok(Math.abs(p.input - 1.0) < 0.001);
});
