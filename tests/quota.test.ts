// 额度类型与派生计算
//
// 这组测试的重点是「算不出来就返回 null，不猜」——
// 额度数据一旦编造，用户按错误的数字做决策，比不显示更糟。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paceDelta, untilReset, tension } from '../src/core/quota/types.ts';
import type { RateWindow, ProviderQuota } from '../src/core/quota/types.ts';

const NOW = Date.parse('2026-10-29T12:00:00+08:00');

test('paceDelta：用得快于线性节奏时为正', () => {
  // 5 小时窗口，2.5 小时后重置（过半），但已用 80%
  const w: RateWindow = {
    id: 't', label: 't', percent: 80,
    windowMinutes: 300,
    resetsAt: new Date(NOW + 150 * 60_000).toISOString(),
  };
  const d = paceDelta(w, NOW);
  assert.ok(d !== null);
  assert.ok(Math.abs(d - 30) < 0.5, `应为 +30 左右，实际 ${d}`);
});

test('paceDelta：用得慢于线性节奏时为负', () => {
  // 窗口过半但只用了 20%
  const w: RateWindow = {
    id: 't', label: 't', percent: 20,
    windowMinutes: 300,
    resetsAt: new Date(NOW + 150 * 60_000).toISOString(),
  };
  const d = paceDelta(w, NOW);
  assert.ok(d !== null && d < 0, `应为负数，实际 ${d}`);
});

test('paceDelta：缺 resetsAt 或 windowMinutes 时返回 null，不猜', () => {
  assert.equal(paceDelta({ id: 't', label: 't', percent: 50 }, NOW), null);
  assert.equal(
    paceDelta({ id: 't', label: 't', percent: 50, resetsAt: '2026-11-01T00:00:00+08:00' }, NOW),
    null,
    '只有重置时间没有窗口长度也算不出节奏',
  );
});

test('paceDelta：窗口刚开始时不判断（样本太小无意义）', () => {
  const w: RateWindow = {
    id: 't', label: 't', percent: 99,
    windowMinutes: 300,
    resetsAt: new Date(NOW + 299 * 60_000).toISOString(), // 才过 1 分钟
  };
  assert.equal(paceDelta(w, NOW), null);
});

test('untilReset：各时间尺度的人话描述', () => {
  const mk = (mins: number): RateWindow => ({
    id: 't', label: 't', percent: 0,
    resetsAt: new Date(NOW + mins * 60_000).toISOString(),
  });
  assert.match(untilReset(mk(30), NOW) ?? '', /分钟后/);
  assert.match(untilReset(mk(180), NOW) ?? '', /小时/);
  assert.match(untilReset(mk(60 * 50), NOW) ?? '', /天/);
  assert.match(untilReset(mk(-5), NOW) ?? '', /即将重置/);
});

test('tension：取所有窗口里已用最高的那个', () => {
  const q: ProviderQuota = {
    id: 'x', displayName: 'X', source: 'cli', ok: true, fetchedAt: 0,
    windows: [
      { id: 'a', label: 'a', percent: 20 },
      { id: 'b', label: 'b', percent: 85 },
    ],
  };
  assert.equal(tension(q), 85);

  const withPlan: ProviderQuota = {
    ...q,
    windows: [{ id: 'a', label: 'a', percent: 10 }],
    tokenPlan: { percent: 92 },
  };
  assert.equal(tension(withPlan), 92, 'tokenPlan 也要参与比较');
});

test('tension：没有任何额度数据时为 0，不抛异常', () => {
  const q: ProviderQuota = { id: 'x', displayName: 'X', source: 'api', ok: false, fetchedAt: 0 };
  assert.equal(tension(q), 0);
});
