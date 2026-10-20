#!/usr/bin/env node
// token-pilot CLI

import { claudeCodeAdapter } from '../adapters/claude-code.ts';
import { costOf } from '../core/pricing.ts';
import type { UsageEvent } from '../core/schema.ts';

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfMonth(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Agg {
  tokens: number;
  cost: number;
  events: number;
  models: Map<string, { tokens: number; cost: number }>;
}

function aggregate(events: UsageEvent[]): Agg {
  const agg: Agg = { tokens: 0, cost: 0, events: events.length, models: new Map() };
  for (const e of events) {
    const c = costOf(e.model, e.usage);
    agg.tokens += e.usage.totalTokens;
    agg.cost += c.totalUsd;
    const m = agg.models.get(e.model) ?? { tokens: 0, cost: 0 };
    m.tokens += e.usage.totalTokens;
    m.cost += c.totalUsd;
    agg.models.set(e.model, m);
  }
  return agg;
}

function fmtUsd(n: number): string {
  return '$' + n.toFixed(2);
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

async function main() {
  const cmd = process.argv[2] ?? 'today';

  const since =
    cmd === 'today' ? startOfToday() :
    cmd === 'month' ? startOfMonth() :
    0;

  console.log(`\ntoken-pilot · ${cmd === 'today' ? '今天' : cmd === 'month' ? '本月' : '全部'}\n`);

  if (!(await claudeCodeAdapter.detect())) {
    console.log('未检测到 Claude Code（~/.claude 不存在）');
    return;
  }

  const events = await claudeCodeAdapter.readEvents(since);
  if (events.length === 0) {
    console.log('该时段无用量记录');
    return;
  }

  const agg = aggregate(events);

  // 按模型分
  console.log('按模型：');
  const sorted = [...agg.models.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [model, m] of sorted) {
    console.log(`  ${model.padEnd(28)} ${fmtTokens(m.tokens).padStart(8)} tokens   ${fmtUsd(m.cost).padStart(8)}`);
  }

  console.log('');
  console.log(`合计：${fmtTokens(agg.tokens)} tokens · ${fmtUsd(agg.cost)} · ${agg.events} 次调用`);

  if (cmd === 'month') {
    const today = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const forecast = (agg.cost / today) * daysInMonth;
    console.log(`\n照这个速度，月底预计：${fmtUsd(forecast)}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('错误：', e.message);
  process.exit(1);
});
