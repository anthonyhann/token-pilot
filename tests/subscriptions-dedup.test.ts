// 订阅登记去重 —— 防止同一笔订阅费被算两次。
//
// 背景：「订阅登记」是手填月费，「订阅额度与余额」是从接口查到的套餐。
// 如果一个平台的套餐价格既能从接口拿到、用户又手填了一遍，
// 账单里就会把同一笔钱加两次。这组测试锁住去重规则。
//
// 另一个约束：拿不到价格时**绝不编**。宁可让用户手填，也不能猜一个数字
// 自动算进他的账单。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubscriptions } from '../src/core/aggregate.ts';
import type { QuotaSnapshot } from '../src/core/quota/types.ts';

const snap = (providers: QuotaSnapshot['providers']): QuotaSnapshot => ({
  generatedAt: Date.now(),
  providers,
});

test('接口能查到套餐且价格明确 → 自动识别，不再需要手填', () => {
  const quota = snap([
    {
      id: 'minimax',
      displayName: 'MiniMax',
      source: 'api',
      ok: true,
      fetchedAt: Date.now(),
      tokenPlan: { planName: 'MiniMax Token Plan', monthlyCny: 199 },
    },
  ]);
  const out = buildSubscriptions({}, quota);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'MiniMax Token Plan');
  assert.equal(out[0].monthlyCny, 199);
  assert.equal(out[0].origin, "api");
  assert.equal(out[0].providerId, 'minimax');
});

test('用户手填了同名订阅 → 被自动识别覆盖，不重复计费', () => {
  const quota = snap([
    {
      id: 'minimax',
      displayName: 'MiniMax',
      source: 'api',
      ok: true,
      fetchedAt: Date.now(),
      tokenPlan: { planName: 'MiniMax Token Plan', monthlyCny: 199 },
    },
  ]);
  // 用户也手填了一条同名、且金额不同（可能记错了）
  const out = buildSubscriptions(
    { subscriptions: [{ name: 'MiniMax Token Plan', monthlyCny: 299 }] },
    quota,
  );
  const total = out.reduce((s, x) => s + x.monthlyCny, 0);
  assert.equal(out.length, 1, `应只剩一条，实际 ${out.length}`);
  assert.equal(total, 199, '总额不能是 199+299=498');
});

test('不同平台的订阅不受影响，照常保留', () => {
  const quota = snap([
    {
      id: 'minimax',
      displayName: 'MiniMax',
      source: 'api',
      ok: true,
      fetchedAt: Date.now(),
      tokenPlan: { planName: 'MiniMax Token Plan', monthlyCny: 199 },
    },
  ]);
  const out = buildSubscriptions(
    { subscriptions: [{ name: 'Claude Pro', monthlyCny: 140 }] },
    quota,
  );
  assert.equal(out.length, 2);
  const claude = out.find((s) => s.name === 'Claude Pro');
  assert.equal(claude?.monthlyCny, 140);
  assert.equal(claude?.origin, "manual");
});

test('接口没返回价格 → 不算自动识别，保留手填', () => {
  // MiniMax 目前就是这样：接口只回用量，不回价格
  const quota = snap([
    {
      id: 'minimax',
      displayName: 'MiniMax',
      source: 'api',
      ok: true,
      fetchedAt: Date.now(),
      tokenPlan: { planName: 'MiniMax Token Plan' }, // 没有 monthlyCny
    },
  ]);
  const out = buildSubscriptions(
    { subscriptions: [{ name: 'MiniMax Token Plan', monthlyCny: 199 }] },
    quota,
  );
  assert.equal(out.length, 1, '应该保留用户手填的那条');
  assert.equal(out[0].origin, "manual");
  assert.equal(out[0].monthlyCny, 199);
});

test('没有套餐名 → 不自动识别（避免把无名字段当套餐）', () => {
  const quota = snap([
    {
      id: 'x',
      displayName: 'X',
      source: 'api',
      ok: true,
      fetchedAt: Date.now(),
      tokenPlan: { monthlyCny: 100 }, // 有价格没名字
    },
  ]);
  const out = buildSubscriptions({}, quota);
  assert.equal(out.filter((s) => s.origin === "api").length, 0);
});

test('查询失败的平台不产生自动识别条目', () => {
  const quota = snap([
    {
      id: 'minimax',
      displayName: 'MiniMax',
      source: 'api',
      ok: false, // 失败
      error: '当前没有生效的 Token Plan 订阅',
      fetchedAt: Date.now(),
      tokenPlan: { planName: 'MiniMax Token Plan', monthlyCny: 199 },
    },
  ]);
  const out = buildSubscriptions({}, quota);
  assert.equal(out.length, 0, '失败的平台不该冒出一条订阅');
});

test('quota 为 null 时不崩，手填照常生效', () => {
  const out = buildSubscriptions(
    { subscriptions: [{ name: 'Claude Pro', monthlyCny: 140 }] },
    null,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].monthlyCny, 140);
});

test('没有任何订阅时返回空数组', () => {
  assert.deepEqual(buildSubscriptions({}, null), []);
  assert.deepEqual(buildSubscriptions({}, snap([])), []);
});
