#!/usr/bin/env node
// token-pilot CLI — 多宿主聚合

import { claudeCodeAdapter } from '../adapters/claude-code.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { kimiCodeAdapter } from '../adapters/kimi-code.ts';
import { costOf } from '../core/pricing.ts';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from '../adapters/types.ts';

const ALL_ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, kimiCodeAdapter];

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

interface CellAgg {
  tokens: number;
  cost: number;
  events: number;
}
type Key = string;
interface Agg {
  tokens: number;
  cost: number;
  events: number;
  byAgent: Map<Key, CellAgg>;
  byModel: Map<Key, CellAgg>;
}

function aggregate(events: UsageEvent[]): Agg {
  const agg: Agg = { tokens: 0, cost: 0, events: events.length, byAgent: new Map(), byModel: new Map() };
  for (const e of events) {
    const c = costOf(e.model, e.usage);
    const tok = e.usage.totalTokens;
    agg.tokens += tok;
    agg.cost += c.totalUsd;

    for (const [map, key] of [[agg.byAgent, e.agent], [agg.byModel, e.model]] as const) {
      const cell = map.get(key) ?? { tokens: 0, cost: 0, events: 0 };
      cell.tokens += tok;
      cell.cost += c.totalUsd;
      cell.events += 1;
      map.set(key, cell);
    }
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

function printMap(title: string, map: Map<Key, CellAgg>) {
  console.log(title);
  const sorted = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [key, c] of sorted) {
    console.log(`  ${key.padEnd(30)} ${fmtTokens(c.tokens).padStart(9)} tokens   ${fmtUsd(c.cost).padStart(9)}   ${c.events} 次`);
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'today';
  const since =
    cmd === 'today' ? startOfToday() :
    cmd === 'month' ? startOfMonth() :
    0;

  const label = cmd === 'today' ? '今天' : cmd === 'month' ? '本月' : '全部';
  console.log(`\ntoken-pilot · ${label}\n`);

  const allEvents: UsageEvent[] = [];
  const detected: string[] = [];
  const noData: string[] = [];
  for (const ad of ALL_ADAPTERS) {
    if (!(await ad.detect())) continue;
    detected.push(ad.meta.displayName);
    const evs = await ad.readEvents(since);
    if (evs.length === 0) noData.push(ad.meta.displayName);
    allEvents.push(...evs);
  }

  console.log(`已检测宿主：${detected.join('、') || '无'}`);
  if (noData.length) console.log(`（${noData.join('、')} 该时段无用量）`);
  console.log('');

  if (allEvents.length === 0) {
    console.log('该时段无用量记录');
    return;
  }

  const agg = aggregate(allEvents);

  printMap('按宿主：', agg.byAgent);
  console.log('');
  printMap('按模型：', agg.byModel);

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
