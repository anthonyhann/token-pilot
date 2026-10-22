#!/usr/bin/env node
// token-pilot CLI — 多宿主聚合
// 命令：today | month | report | sync | dash | serve

import { costOf, loadPricingWithOverrides } from '../core/pricing.ts';
import { progressBar } from '../core/budget.ts';
import { detectRetryLoops } from '../core/retry-detector.ts';
import { savingsAdvice } from '../core/savings.ts';
import { notify } from '../core/alert.ts';
import { loadConfig, fxRate, monthlyBudgetCny } from '../core/config.ts';
import { writeSummary } from '../core/metrics.ts';
import { collectAll, collectCached, acquireSyncLock, releaseSyncLock } from '../core/collector.ts';
import { hasKnownPrice, priceFor } from '../core/pricing.ts';
import { trackUnknown, loadUnknown } from '../core/unknown-models.ts';
import { autoFetchPrices, autoOverrides } from '../core/price-fetch.ts';
import { buildDashboardData } from '../core/aggregate.ts';
import { serve, bakeDashboard, writeDashboardDataFile } from './serve.ts';
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

interface CellAgg {
  tokens: number;
  cost: number;
  events: number;
}
interface Agg {
  tokens: number;
  cost: number;
  events: number;
  byAgent: Map<string, CellAgg>;
  byModel: Map<string, CellAgg>;
}

function aggregate(events: UsageEvent[]): Agg {
  const agg: Agg = { tokens: 0, cost: 0, events: events.length, byAgent: new Map(), byModel: new Map() };
  for (const e of events) {
    const c = costOf(e.model, e.usage, undefined, e.timestamp);
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

function printMap(title: string, map: Map<string, CellAgg>) {
  console.log(title);
  const sorted = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [key, c] of sorted) {
    console.log(`  ${key.padEnd(30)} ${fmtTokens(c.tokens).padStart(9)} tokens   ${fmtUsd(c.cost).padStart(9)}   ${c.events} 次`);
  }
}

async function cmdReport(cmd: string) {
  const since = cmd === 'today' ? startOfToday() : cmd === 'month' ? startOfMonth() : 0;
  const label = cmd === 'today' ? '今天' : cmd === 'month' ? '本月' : '全部';
  console.log(`\ntoken-pilot · ${label}\n`);

  const { events: allEvents, detected } = await collectAll(since);
  console.log(`已检测宿主：${detected.join('、') || '无'}\n`);

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

  const cfg = loadConfig();
  const budgetCny = monthlyBudgetCny(cfg);
  if (budgetCny) {
    const { events: monthEvents } = await collectAll(startOfMonth());
    const monthCostUsd = monthEvents.reduce((s, e) => s + costOf(e.model, e.usage, undefined, e.timestamp).totalUsd, 0);
    const monthCostCny = monthCostUsd * fxRate(cfg);
    const pct = (monthCostCny / budgetCny) * 100;
    const forecast = (monthCostCny / new Date().getDate()) * new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    console.log('');
    console.log(`预算：¥${monthCostCny.toFixed(0)} / ¥${budgetCny}  ${progressBar(pct)}`);
    console.log(`照这个速度，月底预计：¥${forecast.toFixed(0)}${forecast > budgetCny ? '（预计超支）' : ''}`);
    const threshold = cfg.alertOnPercent ?? 80;
    if (pct >= threshold) {
      notify('token-pilot 预算告警', `本月已用 ${pct.toFixed(0)}%（¥${monthCostCny.toFixed(0)} / ¥${budgetCny}）`);
    }
  } else if (cmd === 'month') {
    const today = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    console.log(`\n照这个速度，月底预计：${fmtUsd((agg.cost / today) * daysInMonth)}`);
  }

  // 同步写 summary（兼容菜单栏旧路径）
  try {
    const todayEvents = allEvents.filter((e) => e.timestamp >= startOfToday());
    const monthEvents = cmd === 'month' ? allEvents : (await collectAll(startOfMonth())).events;
    writeSummary(todayEvents, monthEvents, undefined);
  } catch { /* 不阻塞 */ }

  if (cmd === 'report' || cmd === 'month') {
    const alerts = detectRetryLoops(allEvents, (m, u) => costOf(m, u));
    if (alerts.length > 0) {
      console.log('\n打转/异常重试检测：');
      for (const a of alerts.slice(0, 5)) {
        console.log(`  ⚠️ ${a.agent} · ${a.model} · ${a.calls} 次 · ${fmtUsd(a.totalCostUsd)} — ${a.reason}`);
      }
    }
    const savings = savingsAdvice(allEvents);
    if (savings.length > 0) {
      console.log('\n省钱建议：');
      for (const s of savings) {
        console.log(`  💡 ${s.observation}`);
        console.log(`     ${s.suggestion}（约省 ${fmtUsd(s.estimatedSavingsUsdPerMonth)}/月）`);
      }
    }
  }
  console.log('');
}

async function cmdSync(): Promise<void> {
  // 单飞：已有 sync 在跑直接退出（菜单栏 60s 定时器叠加 spawn 也不会堆积）
  if (!(await acquireSyncLock())) {
    console.log('已有 sync 在运行，跳过');
    return;
  }
  try {
    const cfg = loadConfig();
    const fx = fxRate(cfg);
    const pricing = loadPricingWithOverrides({ ...autoOverrides(), ...(cfg.priceOverrides ?? {}) }, fx);
    const { events, contentEvents, detected, parsedFiles, cachedFiles } = await collectCached(0);

    // 未知模型追踪：定价表+覆写都没有的，记账待补价
    const seen = new Set<string>();
    for (const e of events) {
      if (seen.has(e.model)) continue;
      seen.add(e.model);
      if (!hasKnownPrice(e.model, pricing)) trackUnknown(e.model, e.agent);
    }
    // 每天最多一次自动查价补全
    const fetched = await maybeAutoFetch(fx);
    if (fetched.length > 0) {
      console.log('自动补价（待核对）：');
      for (const n of fetched) console.log(`  + ${n}`);
    }

    const data = await buildDashboardData(events, cfg, loadPricingWithOverrides({ ...autoOverrides(), ...(cfg.priceOverrides ?? {}) }, fx), contentEvents);
    writeDashboardDataFile(data);
    console.log(`token-pilot sync · ${detected.length} 宿主 · 解析 ${parsedFiles} 文件 / 缓存命中 ${cachedFiles}`);
    console.log(`今日：¥${data.hero.today.costCny.toFixed(2)} · ${data.hero.today.calls} 次调用 · 托盘：${data.trayTitle}`);
  } finally {
    await releaseSyncLock();
  }
}

// 自动补价节流：每天最多一次（状态落盘，跨进程生效）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../core/config.ts';
const FETCH_STATE = path.join(CONFIG_DIR, 'price-fetch-state.json');
async function maybeAutoFetch(fx: number): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(FETCH_STATE)) {
      const s = JSON.parse(readFileSync(FETCH_STATE, 'utf8'));
      if (s.lastRun === today) return [];
    }
  } catch { /* 重来 */ }
  const notes = await autoFetchPrices(fx, 3);
  try { writeFileSync(FETCH_STATE, JSON.stringify({ lastRun: today }), 'utf8'); } catch { /* 忽略 */ }
  return notes;
}

async function cmdDash(): Promise<void> {
  const out = await bakeDashboard();
  console.log(`已生成 ${out}`);
  try {
    const { spawn } = await import('node:child_process');
    spawn('open', [out], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 手动打开 */ }
}

// 价格核对台：每个在用的模型当前按什么价算、价格从哪来
function cmdPrices(): void {
  const cfg = loadConfig();
  const fx = fxRate(cfg);
  const pricing = loadPricingWithOverrides({ ...autoOverrides(), ...(cfg.priceOverrides ?? {}) }, fx);
  const unknown = loadUnknown();

  console.log('\ntoken-pilot · 价格核对台（¥ / 1M tokens）\n');
  console.log('  模型'.padEnd(34) + '输入'.padStart(8) + '输出'.padStart(8) + '缓存读'.padStart(8) + '   来源');

  const rows = new Set<string>([...Object.keys(pricing.models), ...Object.keys(unknown)]);
  const lines: string[] = [];
  for (const m of rows) {
    const p = priceFor(m, pricing);
    const inC = (p.input * fx).toFixed(2);
    const outC = (p.output * fx).toFixed(2);
    const crC = ((p.cacheRead ?? p.input * 0.1) * fx).toFixed(2);
    let src = '目录价';
    if (cfg.priceOverrides?.[m]) src = '人工覆写 ✓';
    else if (unknown[m]?.autoPrice) src = `自动填充·待核对（${unknown[m].source ?? ''}）`;
    else if (!hasKnownPrice(m)) src = '⚠️ 无定价，按 fallback 估';
    lines.push(`  ${m.padEnd(32)}${inC.padStart(8)}${outC.padStart(8)}${crC.padStart(8)}   ${src}`);
  }
  lines.sort().forEach((l) => console.log(l));
  const pending = Object.values(unknown).filter((u) => u.autoPrice && u.needsReview);
  if (pending.length) {
    console.log(`\n  ${pending.length} 个自动填充待核对 → 看板「数据设置」里可直接改`);
  }
  console.log('');
}

// 压缩潜力报告（CLI 明细版）
async function cmdCompressReport(): Promise<void> {
  const cfg = loadConfig();
  const fx = fxRate(cfg);
  const pricing = loadPricingWithOverrides({ ...autoOverrides(), ...(cfg.priceOverrides ?? {}) }, fx);
  const { events, contentEvents } = await collectCached(0);
  const { computeCompression } = await import('../core/compression.ts');
  const r = computeCompression(events, contentEvents, pricing);
  console.log('\ntoken-pilot · 压缩潜力报告（本月）\n');
  if (r.itemCount === 0) {
    console.log('未发现明显可压缩的上下文浪费。');
    return;
  }
  console.log(`可压缩空间（估算）：$${r.potentialUsd.toFixed(2)} – $${r.potentialUsdMax.toFixed(2)} / 月`);
  console.log(`模式拆分：陈旧 tool 输出 $${r.patterns.stale.toFixed(2)} · 重复读取 $${r.patterns.reread.toFixed(2)} · 超长输出 $${r.patterns.long.toFixed(2)}`);
  console.log('\n最浪费的会话：');
  for (const s of r.sessions) {
    console.log(`  ${s.agent} · ${s.key.slice(-16)} · $${s.wasteUsd.toFixed(2)} · ${s.items} 处 · ${s.topPatterns.join('/')}`);
  }
  console.log('\n建议：上下文压缩代理可把这部分省下来（规则法已验证 −29%~−48% 输入）。');
  console.log('');
}

async function main() {
  const cmd = process.argv[2] ?? 'today';
  if (cmd === 'serve') {
    const port = Number(process.argv[3] ?? 17895);
    await serve(port);
    return;
  }
  if (cmd === 'sync') return cmdSync();
  if (cmd === 'dash') return cmdDash();
  if (cmd === 'prices') return cmdPrices();
  if (cmd === 'compress-report') return cmdCompressReport();
  if (cmd === 'today' || cmd === 'month' || cmd === 'report' || cmd === 'all') {
    return cmdReport(cmd === 'all' ? 'all' : cmd);
  }
  console.log('用法：token-pilot [today|month|report|sync|dash|serve]');
}

main().catch((e) => {
  console.error('错误：', e.message);
  process.exit(1);
});
