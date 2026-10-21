// 聚合引擎测试：合成事件 → DashboardData 不变量

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardData } from '../src/core/aggregate.ts';
import type { UsageEvent } from '../src/core/schema.ts';
import type { PricingTable } from '../src/core/pricing.ts';
import type { TokenPilotConfig } from '../src/core/config.ts';

const pricing: PricingTable = {
  models: {
    'test-model': { provider: 'test', input: 1.0, output: 2.0, cacheRead: 0.1, cacheCreation: 1.25 },
  },
  fallback: { provider: 'x', input: 1.0, output: 5.0 },
};

function ev(offsetMs: number, over: Partial<UsageEvent> & { out?: number; inp?: number; cr?: number; cw?: number } = {}): UsageEvent {
  const inp = over.inp ?? 1000;
  const out = over.out ?? 500;
  const cr = over.cr ?? 9000;
  const cw = over.cw ?? 0;
  return {
    agent: over.agent ?? 'claude-code',
    sessionId: over.sessionId ?? 's1',
    eventId: over.eventId ?? `e-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now() - offsetMs,
    provider: 'test',
    model: over.model ?? 'test-model',
    usage: {
      inputTokens: inp, outputTokens: out, cacheReadTokens: cr, cacheCreationTokens: cw,
      totalTokens: inp + out + cr + cw,
    },
    workspace: over.workspace ?? '/proj-a',
  };
}

const H = 3600_000;
const DAY = 86400_000;

test('周期包含关系 + 趋势末日=今日', async () => {
  const events = [ev(1 * H), ev(3 * DAY), ev(10 * DAY), ev(40 * DAY)]; // 40 天前不进本月
  const d = await buildDashboardData(events, {}, pricing);
  assert.ok(d.hero.today.costCny <= d.hero.week.costCny + 1e-9);
  assert.ok(d.hero.week.costCny <= d.hero.month.costCny + 1e-9);
  assert.equal(d.trend.days.length, 28);
  const lastDay = d.trend.days[d.trend.days.length - 1];
  assert.ok(Math.abs(lastDay.costUsd * d.usdToCny - d.hero.today.costCny) < 0.01);
  // 40 天前的事件不进任何周期
  assert.ok(d.hero.month.costCny > 0);
  assert.ok(d.hero.month.calls <= 3);
});

test('构成 pct≈100（三周期三维度）', async () => {
  const events = [
    ev(1 * H, { model: 'test-model', agent: 'claude-code', workspace: '/a' }),
    ev(2 * H, { model: 'fallback-model', agent: 'codex', workspace: '/b' }),
    ev(3 * DAY, { model: 'test-model', agent: 'kimi-code', workspace: '/c' }),
  ];
  const d = await buildDashboardData(events, {}, pricing);
  for (const period of ['today', 'week', 'month'] as const) {
    for (const dim of ['model', 'tool', 'proj'] as const) {
      const rows = d.mix[period][dim];
      if (rows.length) {
        const sum = rows.reduce((s, r) => s + r.pct, 0);
        assert.ok(Math.abs(sum - 100) < 1.5, `${period}.${dim} pct=${sum}`);
      }
    }
  }
});

test('live 分摊总量守恒：buckets60×20s ≈ 近 60 分钟 output 总量', async () => {
  // 同会话两个事件相隔 60s，第二个 output=6000 应分摊到这 60s 窗口
  const events = [
    ev(90_000, { sessionId: 'live-1', out: 0 }),
    ev(30_000, { sessionId: 'live-1', out: 6000, inp: 0, cr: 0 }),
  ];
  const d = await buildDashboardData(events, {}, pricing);
  const sumTok = d.live.buckets60.reduce((s, r) => s + r * 20, 0);
  assert.ok(Math.abs(sumTok - 6000) < 1, `分摊后总量 ${sumTok} ≠ 6000`);
  // 分摊：曲线应覆盖多个桶而非单点
  const nonZero = d.live.buckets60.filter((r) => r > 0).length;
  assert.ok(nonZero >= 2, `只有 ${nonZero} 个非零桶，说明没分摊`);
  // 速率峰值不应超过 6000/60=100（若全压在一个桶会是 300）
  assert.ok(d.live.peakTokS <= 101, `peak ${d.live.peakTokS} 超上限`);
});

test('预算：spent = 本月用量×汇率 + 固定费；pct 自洽', async () => {
  const events = [ev(1 * H, { out: 1_000_000, inp: 1_000_000, cr: 0 })]; // $1×1M in + $2×1M out = $3
  const cfg: TokenPilotConfig = {
    monthlyBudgetCny: 1500,
    usdToCny: 7.0,
    subscriptions: [{ name: 'X', monthlyCny: 100 }],
    cloudApis: [{ name: 'Y', monthlyCny: 50 }],
  };
  const d = await buildDashboardData(events, cfg, pricing);
  assert.ok(d.budget);
  const expect = 3 * 7.0 + 150;
  assert.ok(Math.abs(d.budget!.spentCny - expect) < 0.01, `spent ${d.budget!.spentCny} ≠ ${expect}`);
  assert.ok(Math.abs(d.budget!.pct - (expect / 1500) * 100) < 0.01);
  assert.ok(d.trayTitle.includes('¥'));
});

test('无预算时 budget=null 且托盘只显示金额', async () => {
  const d = await buildDashboardData([ev(1000)], {}, pricing);
  assert.equal(d.budget, null);
  assert.ok(!d.trayTitle.includes('%'));
});

test('缓存省钱 = Σ cacheRead × (input − cacheRead 价) × 汇率', async () => {
  // 本月一次调用：cacheRead 10M，test-model 省 (1.0−0.1)×10 = $9 → ×7.2 = ¥64.8
  const d = await buildDashboardData([ev(1 * H, { cr: 10_000_000 })], { usdToCny: 7.2 }, pricing);
  assert.ok(d.cacheStrip);
  assert.ok(Math.abs(d.cacheStrip!.savedCny - 64.8) < 0.5, `saved ${d.cacheStrip!.savedCny}`);
});

test('会话 spark 恒为 10 桶；活跃判定 2 分钟', async () => {
  const events = [
    ev(30_000, { sessionId: 'hot', out: 100 }),
    ev(5 * 60_000, { sessionId: 'warm', out: 100 }),
  ];
  const d = await buildDashboardData(events, {}, pricing);
  for (const s of d.live.sessions) {
    assert.equal(s.spark.length, 10);
  }
  const hot = d.live.sessions.find((s) => s.key.includes('hot'));
  assert.ok(hot?.active);
});
