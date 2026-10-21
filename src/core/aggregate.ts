// 聚合引擎 — 单遍扫描 UsageEvent[]，产出 DashboardData 契约全量
// 原则：快计算（一次排序 + 一次主循环）、金额内部 USD、展示 CNY 由 fx 折算

import type { UsageEvent } from './schema.ts';
import type {
  DashboardData, HeroPeriod, HeroPill, StatCard, DayPoint, MixRow, RankRow,
  LiveData, LiveSession, SavingsCard, SettingsData, AdapterTier,
} from './contract.ts';
import { costOf, cacheSavingsUsd, priceFor, type PricingTable } from './pricing.ts';
import { fxRate, monthlyBudgetCny, type TokenPilotConfig } from './config.ts';
import { detectRetryLoops } from './retry-detector.ts';
import { savingsAdvice } from './savings.ts';
import { buildAdapterTiers, HOST_TIERS } from './registry.ts';

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'kimi-code': 'Kimi Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
  'qoder': 'Qoder',
  'pi': 'pi',
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic', deepseek: 'DeepSeek', glm: '智谱', kimi: 'Moonshot',
  openai: 'OpenAI', qwen: '阿里', doubao: '字节', minimax: 'MiniMax',
  hunyuan: '腾讯', mimo: '小米', longcat: '美团', unknown: '未知',
};

const WD = '日一二三四五六';

// ---------- 时间边界 ----------
function startOfToday(now: Date): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
}
function startOfWeek(now: Date): number {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const dow = d.getDay();           // 0=周日
  d.setDate(d.getDate() - ((dow + 6) % 7)); // 周一
  return d.getTime();
}
function startOfMonth(now: Date): number {
  const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime();
}
function daysInMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

// ---------- 格式化 ----------
export function fmtCny(n: number): string {
  if (n >= 100) return '¥' + Math.round(n).toLocaleString('zh-CN');
  const s = n.toFixed(2);
  return '¥' + (s.endsWith('0') ? s.slice(0, -1) : s);
}
export function fmtTok(n: number): string {
  if (n >= 1e8) return trim1(n / 1e8) + '亿';
  if (n >= 1e4) return trim1(n / 1e4) + '万';
  return String(Math.round(n));
}
function trim1(n: number): string {
  const s = n.toFixed(n >= 100 ? 0 : 1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
function agoLabel(ts: number, now: number): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 90) return '刚刚';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} 分钟前`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- 周期聚合 ----------
interface PeriodAgg {
  costUsd: number; tokens: number; output: number; calls: number;
  cacheRead: number; cacheCreation: number; input: number;
}
function newAgg(): PeriodAgg {
  return { costUsd: 0, tokens: 0, output: 0, calls: 0, cacheRead: 0, cacheCreation: 0, input: 0 };
}
function hitRateOf(a: PeriodAgg): number {
  const denom = a.cacheRead + a.cacheCreation + a.input;
  return denom > 0 ? a.cacheRead / denom : 0;
}

interface Priced extends UsageEvent { _costUsd: number }

export async function buildDashboardData(
  rawEvents: UsageEvent[],
  cfg: TokenPilotConfig,
  pricing: PricingTable,
): Promise<DashboardData> {
  const now = new Date();
  const nowMs = now.getTime();
  const fx = fxRate(cfg);

  // 排序 + 预算成本（单遍）
  const events: Priced[] = rawEvents
    .filter((e) => e.timestamp > 0)
    .map((e) => {
      const c = costOf(e.model, e.usage, pricing);
      return Object.assign(e, { _costUsd: c.totalUsd, _cost: c });
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const t0 = startOfToday(now);
  const w0 = startOfWeek(now);
  const m0 = startOfMonth(now);
  const d30 = nowMs - 30 * 86400_000;
  const d28 = t0 - 27 * 86400_000;
  const d14 = t0 - 13 * 86400_000;
  const d7 = nowMs - 7 * 86400_000;

  const today = newAgg(); const week = newAgg(); const month = newAgg(); const last30 = newAgg();
  // 14/28 天日序列种子（六指标全记，统计卡 mini 要用）
  interface DayAgg { cost: number; tokens: number; calls: number; output: number; cacheRead: number; cacheCreation: number; input: number }
  const dayMap = new Map<number, DayAgg>();
  for (let i = 0; i < 28; i++) dayMap.set(d28 + i * 86400_000, { cost: 0, tokens: 0, calls: 0, output: 0, cacheRead: 0, cacheCreation: 0, input: 0 });

  // per-model / per-agent / per-project（今日，供排行榜与速率子行）
  interface Cell { cost: number; tokens: number; calls: number; output: number; cacheRead: number; cacheCreation: number; input: number; lastTs: number; agent: string }
  const byModel = new Map<string, Cell>();
  const byAgent = new Map<string, Cell>();
  const byProj = new Map<string, Cell>();

  // 今日成本分项
  const split = { cacheRead: 0, cacheWrite: 0, output: 0, newInput: 0 };

  // 速率样本（同会话相邻事件）
  let prevBySession = new Map<string, { ts: number }>();
  const speedToday: number[] = [];
  const speedByModel = new Map<string, number[]>();
  const speedByDay = new Map<number, number[]>();

  // 会话（实时 + 命中率优化共用）
  interface Sess { agent: string; model: string; lastTs: number; out10: number; out60: number; spark: number[]; calls: number; cacheRead: number; cacheCreation: number; input: number; costUsd: number; label: string; title?: string; firstTs: number }
  const sessMap = new Map<string, Sess>();

  const cell = (map: Map<string, Cell>, key: string, e: Priced): Cell => {
    let c = map.get(key);
    if (!c) {
      c = { cost: 0, tokens: 0, calls: 0, output: 0, cacheRead: 0, cacheCreation: 0, input: 0, lastTs: 0, agent: e.agent };
      map.set(key, c);
    }
    return c;
  };

  for (const e of events) {
    const ts = e.timestamp;
    const u = e.usage;
    const cost = e._costUsd;
    const c = (e as unknown as { _cost: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheCreationUsd: number } })._cost;

    if (ts >= t0) {
      today.costUsd += cost; today.tokens += u.totalTokens; today.output += u.outputTokens; today.calls++;
      today.cacheRead += u.cacheReadTokens; today.cacheCreation += u.cacheCreationTokens; today.input += u.inputTokens;
      split.cacheRead += c.cacheReadUsd; split.cacheWrite += c.cacheCreationUsd;
      split.output += c.outputUsd; split.newInput += c.inputUsd;

      cell(byModel, e.model, e);
      cell(byAgent, e.agent, e);
      cell(byProj, projKey(e), e);
      for (const cc of [byModel.get(e.model)!, byAgent.get(e.agent)!, byProj.get(projKey(e))!]) {
        cc.cost += cost; cc.tokens += u.totalTokens; cc.calls++; cc.output += u.outputTokens;
        cc.cacheRead += u.cacheReadTokens; cc.cacheCreation += u.cacheCreationTokens; cc.input += u.inputTokens;
        cc.lastTs = Math.max(cc.lastTs, ts);
      }
    }
    if (ts >= w0) { week.costUsd += cost; week.tokens += u.totalTokens; week.output += u.outputTokens; week.calls++; week.cacheRead += u.cacheReadTokens; week.cacheCreation += u.cacheCreationTokens; week.input += u.inputTokens; }
    if (ts >= m0) { month.costUsd += cost; month.tokens += u.totalTokens; month.output += u.outputTokens; month.calls++; month.cacheRead += u.cacheReadTokens; month.cacheCreation += u.cacheCreationTokens; month.input += u.inputTokens; }
    if (ts >= d30) { last30.costUsd += cost; last30.tokens += u.totalTokens; last30.output += u.outputTokens; last30.calls++; last30.cacheRead += u.cacheReadTokens; last30.cacheCreation += u.cacheCreationTokens; last30.input += u.inputTokens; }

    // 日序列
    if (ts >= d28) {
      // 对齐到当地 0 点
      const d = new Date(ts); d.setHours(0, 0, 0, 0);
      const dp = dayMap.get(d.getTime());
      if (dp) {
        dp.cost += cost; dp.tokens += u.totalTokens; dp.calls++;
        dp.output += u.outputTokens; dp.cacheRead += u.cacheReadTokens;
        dp.cacheCreation += u.cacheCreationTokens; dp.input += u.inputTokens;
      }
    }

    // 速率样本
    const sk = `${e.agent}:${e.sessionId}`;
    const prev = prevBySession.get(sk);
    if (prev) {
      const dur = (ts - prev.ts) / 1000;
      if (dur >= 1 && dur <= 300 && u.outputTokens > 0) {
        const rate = u.outputTokens / dur;
        if (ts >= t0) {
          speedToday.push(rate);
          const arr = speedByModel.get(e.model) ?? []; arr.push(rate); speedByModel.set(e.model, arr);
        }
        if (ts >= d14) {
          const d = new Date(ts); d.setHours(0, 0, 0, 0);
          const arr = speedByDay.get(d.getTime()) ?? []; arr.push(rate); speedByDay.set(d.getTime(), arr);
        }
      }
    }
    prevBySession.set(sk, { ts });

    // 会话聚合（近 7 天内的会话才值得跟）
    if (ts >= d7) {
      let s = sessMap.get(sk);
      if (!s) {
        s = { agent: e.agent, model: e.model, lastTs: 0, out10: 0, out60: 0, spark: [], calls: 0, cacheRead: 0, cacheCreation: 0, input: 0, costUsd: 0, label: projKey(e), title: e.sessionTitle, firstTs: ts };
        sessMap.set(sk, s);
      }
      s.lastTs = Math.max(s.lastTs, ts);
      s.calls++; s.costUsd += cost;
      s.cacheRead += u.cacheReadTokens; s.cacheCreation += u.cacheCreationTokens; s.input += u.inputTokens;
      if (!s.title && e.sessionTitle) s.title = e.sessionTitle;
    }
  }
  prevBySession.clear();

  // ---------- 日序列输出 ----------
  const days: DayPoint[] = [];
  const dayAggs: DayAgg[] = [];
  for (let i = 0; i < 28; i++) {
    const t = d28 + i * 86400_000;
    const d = new Date(t);
    const dp = dayMap.get(t) ?? { cost: 0, tokens: 0, calls: 0, output: 0, cacheRead: 0, cacheCreation: 0, input: 0 };
    dayAggs.push(dp);
    days.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, weekday: `周${WD[d.getDay()]}`, costUsd: dp.cost, tokens: dp.tokens, calls: dp.calls });
  }
  const days14 = days.slice(14);
  const dayAggs14 = dayAggs.slice(14);

  // ---------- 预算 ----------
  const budgetCny = monthlyBudgetCny(cfg);
  const fixedFeesCny = (cfg.cloudApis ?? []).reduce((s, x) => s + (x.monthlyCny || 0), 0)
    + (cfg.subscriptions ?? []).reduce((s, x) => s + (x.monthlyCny || 0), 0);
  const dim = daysInMonth(now);
  const dayOfMonth = now.getDate();
  let budget: DashboardData['budget'] = null;
  if (budgetCny) {
    const spentCny = month.costUsd * fx + fixedFeesCny;
    const forecastCny = (month.costUsd / dayOfMonth) * dim * fx + fixedFeesCny;
    budget = {
      monthlyCny: budgetCny,
      spentCny,
      remainingCny: Math.max(budgetCny - spentCny, 0),
      pct: (spentCny / budgetCny) * 100,
      dailyCny: budgetCny / dim,
      forecastCny,
    };
  }

  // ---------- Hero ----------
  const dailyAvgCny = (month.costUsd / dayOfMonth) * fx;
  const forecastCny = (month.costUsd / dayOfMonth) * dim * fx + fixedFeesCny;
  const mkPills = (p: 'today' | 'week' | 'month'): HeroPill[] => {
    const pills: HeroPill[] = [];
    if (p === 'today') pills.push({ icon: 'cal', label: '本周', value: fmtCny(week.costUsd * fx) });
    if (p === 'week') pills.push({ icon: 'cal', label: '今日', value: fmtCny(today.costUsd * fx) });
    if (p === 'month') {
      pills.push({ icon: 'cal', label: '今日', value: fmtCny(today.costUsd * fx) });
      pills.push({ icon: 'cal', label: '本周', value: fmtCny(week.costUsd * fx) });
    }
    if (p !== 'month') pills.push({ icon: 'cal', label: '近 30 天', value: fmtCny(last30.costUsd * fx) });
    pills.push({ icon: 'clk', label: '日均', value: fmtCny(dailyAvgCny) });
    if (budget && p !== 'month') pills.push({ icon: 'shd', label: '本月预算剩', value: fmtCny(budget.remainingCny) });
    // 月底预计不依赖预算，总能给
    pills.push({ icon: 'trd', label: '月底预计', value: fmtCny(budget ? budget.forecastCny : forecastCny) });
    return pills.slice(0, 4);
  };
  const heroPeriod = (lab: string, a: PeriodAgg, p: 'today' | 'week' | 'month', hosts: number): HeroPeriod => ({
    label: lab,
    costCny: a.costUsd * fx,
    tokens: a.tokens,
    outputTokens: a.output,
    calls: a.calls,
    cacheHitRate: hitRateOf(a),
    hosts,
    pills: mkPills(p),
  });
  const hostsSince = (sinceMs: number): number => {
    const s = new Set<string>();
    for (const e of events) if (e.timestamp >= sinceMs) s.add(e.agent);
    return s.size;
  };
  const hero = {
    today: heroPeriod('今天已花费', today, 'today', hostsSince(t0)),
    week: heroPeriod('本周已花费', week, 'week', hostsSince(w0)),
    month: heroPeriod('本月已花费', month, 'month', hostsSince(m0)),
  };

  // ---------- 缓存省钱条（本月） ----------
  let cacheStrip: DashboardData['cacheStrip'] = null;
  if (month.cacheRead > 0) {
    let savedUsd = 0;
    for (const e of events) {
      if (e.timestamp >= m0 && e.usage.cacheReadTokens > 0) {
        savedUsd += cacheSavingsUsd(e.model, e.usage.cacheReadTokens, pricing);
      }
    }
    cacheStrip = { savedCny: savedUsd * fx, hitRate: hitRateOf(month) };
  }

  // ---------- 实时流速 ----------
  const live = buildLive(events, sessMap, nowMs);

  // ---------- 统计卡 ----------
  const stats = buildStats(today, month, last30, dayOfMonth, dayAggs14, speedToday, speedByDay, d14);

  // ---------- 趋势 ----------
  const sum14Cny = days14.reduce((s, d) => s + d.costUsd, 0) * fx;
  const peakCny = Math.max(...days.map((d) => d.costUsd)) * fx;
  const trend = {
    days,
    budgetDailyCny: budget ? budget.dailyCny : null,
    todaySplit: {
      cacheReadCny: split.cacheRead * fx,
      cacheWriteCny: split.cacheWrite * fx,
      outputCny: split.output * fx,
      newInputCny: split.newInput * fx,
    },
    sum14Cny,
    peakCny,
  };

  // ---------- 构成（今日/本周/本月三周期） ----------
  type CellMap = Map<string, { cost: number }>;
  const cellsFor = (sinceMs: number): { byModel: CellMap; byAgent: CellMap; byProj: CellMap } => {
    const bm: CellMap = new Map(); const ba: CellMap = new Map(); const bp: CellMap = new Map();
    for (const e of events) {
      if (e.timestamp < sinceMs) continue;
      for (const [map, key] of [[bm, e.model], [ba, e.agent], [bp, projKey(e)]] as const) {
        const c = map.get(key) ?? { cost: 0 };
        c.cost += e._costUsd;
        map.set(key, c);
      }
    }
    return { byModel: bm, byAgent: ba, byProj: bp };
  };
  const cellsToday = cellsFor(t0);
  const cellsWeek = cellsFor(w0);
  const cellsMonth = cellsFor(m0);
  const mix = {
    today: { model: mixRows(cellsToday.byModel, today.costUsd), tool: mixRows(cellsToday.byAgent, today.costUsd, (k) => AGENT_NAMES[k] ?? k), proj: mixRows(cellsToday.byProj, today.costUsd) },
    week: { model: mixRows(cellsWeek.byModel, week.costUsd), tool: mixRows(cellsWeek.byAgent, week.costUsd, (k) => AGENT_NAMES[k] ?? k), proj: mixRows(cellsWeek.byProj, week.costUsd) },
    month: { model: mixRows(cellsMonth.byModel, month.costUsd), tool: mixRows(cellsMonth.byAgent, month.costUsd, (k) => AGENT_NAMES[k] ?? k), proj: mixRows(cellsMonth.byProj, month.costUsd) },
  };

  // ---------- Token 趋势主力 ----------
  const topOf = (map: Map<string, Cell>): string => {
    const rows = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
    if (!rows.length || today.costUsd <= 0) return '';
    const [k, v] = rows[0];
    return `${Math.round((v.cost / today.costUsd) * 100)}%`;
  };
  const topName = (map: Map<string, Cell>, fmt?: (k: string) => string): string => {
    const rows = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
    if (!rows.length) return '';
    const k = rows[0][0];
    return fmt ? fmt(k) : k;
  };
  const tokTrend = {
    days,
    top: {
      model: byModel.size ? `主力模型 ${topName(byModel)} 占 ${topOf(byModel)}` : '',
      tool: byAgent.size ? `主力工具 ${topName(byAgent, (k) => AGENT_NAMES[k] ?? k)} 占 ${topOf(byAgent)}` : '',
      proj: byProj.size ? `主力项目 ${topName(byProj)} 占 ${topOf(byProj)}` : '',
    },
  };

  // ---------- 排行 ----------
  const modelRank: RankRow[] = [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 4)
    .map(([name, c]) => {
      const e0 = events.find((e) => e.model === name);
      const prov = PROVIDER_NAMES[e0?.provider ?? 'unknown'] ?? '未知';
      const sp = speedByModel.get(name) ?? [];
      const hit = (c.cacheRead + c.cacheCreation + c.input) > 0 ? Math.round((c.cacheRead / (c.cacheRead + c.cacheCreation + c.input)) * 100) : 0;
      return {
        name,
        meta: `${prov} · ${c.calls} 次调用 · ${agoLabel(c.lastTs, nowMs)}`,
        costUsd: c.cost,
        pct: today.costUsd > 0 ? (c.cost / today.costUsd) * 100 : 0,
        sub: `输出 ${fmtTok(c.output)} · 命中 ${hit}% · ${Math.round(median(sp))} tok/s`,
      };
    });
  if (byModel.size > 4) {
    const rest = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(4);
    const restCost = rest.reduce((s, [, c]) => s + c.cost, 0);
    const restCalls = rest.reduce((s, [, c]) => s + c.calls, 0);
    const restOut = rest.reduce((s, [, c]) => s + c.output, 0);
    const names = rest.map(([n]) => n).slice(0, 2).join(' / ');
    modelRank.push({
      name: '其他',
      meta: `${names}${rest.length > 2 ? ' 等' : ''} · ${restCalls} 次调用`,
      costUsd: restCost,
      pct: today.costUsd > 0 ? (restCost / today.costUsd) * 100 : 0,
      sub: `输出 ${fmtTok(restOut)}`,
    });
  }

  const hostRank: RankRow[] = [...byAgent.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([id, c]) => {
      const tier = HOST_TIERS[id];
      const hit = (c.cacheRead + c.cacheCreation + c.input) > 0 ? Math.round((c.cacheRead / (c.cacheRead + c.cacheCreation + c.input)) * 100) : 0;
      return {
        name: AGENT_NAMES[id] ?? id,
        meta: `${tier?.label ?? ''} · 本地日志 · ${c.calls} 次调用 · ${agoLabel(c.lastTs, nowMs)}`,
        costUsd: c.cost,
        pct: today.costUsd > 0 ? (c.cost / today.costUsd) * 100 : 0,
        tier,
        sub: `输出 ${fmtTok(c.output)} · 命中 ${hit}%`,
      };
    });

  // ---------- 省钱建议 ----------
  const savings = buildSavings(events, cfg, pricing, sessMap, fx, d7, t0);

  // ---------- 适配器状态 ----------
  const adapters: AdapterTier[] = await buildAdapterTiers(cfg);

  // ---------- 设置 ----------
  const settings = buildSettings(events, cfg, pricing, fx, d30);

  // ---------- 托盘 ----------
  const trayTitle = budget
    ? `${fmtCny(today.costUsd * fx)} · ${Math.round(budget.pct)}%`
    : fmtCny(today.costUsd * fx);

  return {
    generatedAt: nowMs,
    usdToCny: fx,
    dateLabel: `${now.getMonth() + 1}月${now.getDate()}日 周${WD[now.getDay()]}`,
    trayTitle,
    hero,
    budget,
    cacheStrip,
    live,
    stats,
    trend,
    mix,
    tokTrend,
    modelRank,
    hostRank,
    savings,
    adapters,
    settings,
  };
}

// ---------- 项目键 ----------
import os from 'node:os';
const HOME_DIR = os.homedir();
function projKey(e: UsageEvent): string {
  if (e.workspace) {
    const ws = e.workspace.replace(/\/+$/, '');
    if (ws === HOME_DIR) return '(主目录)';
    const parts = ws.split('/');
    return '/' + (parts[parts.length - 1] || e.workspace);
  }
  return '(未记录项目)';
}

// ---------- 实时流速 ----------
// tok/s 记账口径修复：日志里一条事件的 tokens 全记在「调用完成时刻」，
// 直接分桶会把整个生成过程的量压进一个 20s 桶（虚高尖峰+滞后）。
// 修复：把每条事件的 output/ctx 按 [同会话上一事件时刻, 完成时刻] 匀速分摊
// （上限 120s 防长停顿稀释），总量不变，速率曲线回到真实形状。
const MAX_SPAN_MS = 120_000;

function buildLive(events: (UsageEvent & { _costUsd: number })[], sessMap: Map<string, { agent: string; model: string; lastTs: number; label: string; title?: string }>, nowMs: number): LiveData {
  const BUCKET = 20_000;
  const N60 = 180; // 60 分钟
  const outB = new Array<number>(N60).fill(0);
  const ctxB = new Array<number>(N60).fill(0);
  const t0 = nowMs - N60 * BUCKET;
  const t10 = nowMs - 600_000;
  const m1 = nowMs - 60_000;

  // 会话分钟桶（spark 用）：key → 10 个 60s 桶
  const sessSpark = new Map<string, number[]>();
  let calls60 = 0;

  const prevTs = new Map<string, number>();
  for (const e of events) {
    const sk = `${e.agent}:${e.sessionId}`;
    const prev = prevTs.get(sk);
    prevTs.set(sk, e.timestamp);
    if (e.timestamp >= m1) calls60++;
    if (e.timestamp < t0) continue;

    const spanStart = Math.max(prev ?? 0, e.timestamp - MAX_SPAN_MS, t0);
    const span = Math.max(e.timestamp - spanStart, 1000);
    const out = e.usage.outputTokens;
    const ctx = e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheCreationTokens;
    if (out === 0 && ctx === 0) continue;

    const i0 = Math.max(0, Math.floor((spanStart - t0) / BUCKET));
    const i1 = Math.min(N60 - 1, Math.floor((e.timestamp - t0) / BUCKET));
    for (let i = i0; i <= i1; i++) {
      const b0 = t0 + i * BUCKET;
      const ov = Math.min(b0 + BUCKET, e.timestamp) - Math.max(b0, spanStart);
      if (ov <= 0) continue;
      outB[i] += (out * ov) / span;
      ctxB[i] += (ctx * ov) / span;
    }

    // 会话 spark：近 10 分钟内的部分按同样口径分摊到 60s 桶
    if (e.timestamp >= t10) {
      let spark = sessSpark.get(sk);
      if (!spark) { spark = new Array<number>(10).fill(0); sessSpark.set(sk, spark); }
      const s0 = Math.max(spanStart, t10);
      const j0 = Math.max(0, Math.floor((s0 - t10) / 60_000));
      const j1 = Math.min(9, Math.floor((e.timestamp - t10) / 60_000));
      const sSpan = Math.max(e.timestamp - s0, 1000);
      for (let j = j0; j <= j1; j++) {
        const b0 = t10 + j * 60_000;
        const ov = Math.min(b0 + 60_000, e.timestamp) - Math.max(b0, s0);
        if (ov <= 0) continue;
        spark[j] += (out * ov) / sSpan;
      }
    }
  }

  const rates = outB.map((v) => v / 20);
  let peak = 0; let peakIdx = 0;
  rates.forEach((r, i) => { if (r > peak) { peak = r; peakIdx = i; } });
  // 当前/上下文：近 60s = 末 3 桶
  const out60 = outB[N60 - 1] + outB[N60 - 2] + outB[N60 - 3];
  const ctx60 = ctxB[N60 - 1] + ctxB[N60 - 2] + ctxB[N60 - 3];

  // 会话：近 30 分钟有事件的进入列表
  const sessions: LiveSession[] = [];
  let activeCount = 0; let idleCount = 0;
  const sorted = [...sessMap.entries()]
    .filter(([, s]) => nowMs - s.lastTs < 30 * 60_000)
    .sort((a, b) => b[1].lastTs - a[1].lastTs);
  for (const [key, s] of sorted) {
    const active = nowMs - s.lastTs < 120_000;
    if (active) activeCount++; else idleCount++;
    if (sessions.length >= 5) continue;
    // out10min 仍是原始量（计数不是速率）；rate/spark 用分摊后的分钟桶
    let out10 = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.timestamp < t10) break;
      if (`${e.agent}:${e.sessionId}` !== key) continue;
      out10 += e.usage.outputTokens;
    }
    const spark = sessSpark.get(key) ?? new Array<number>(10).fill(0);
    sessions.push({
      key,
      label: s.title ? `${s.label} · ${s.title}` : s.label,
      model: s.model,
      active,
      ago: agoLabel(s.lastTs, nowMs),
      out10min: out10,
      rateTokS: spark[9] / 60,
      spark: spark.map((v) => v / 60),
    });
  }

  return {
    currentTokS: out60 / 60,
    peakTokS: peak,
    peakAt: peak > 0 ? hhmm(t0 + peakIdx * BUCKET) : '—',
    ctxPerMin: ctx60,
    callsPerMin: calls60,
    activeCount,
    idleCount,
    buckets30: rates.slice(90),
    buckets60: rates,
    sessions,
  };
}

// ---------- 统计卡 ----------
function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p90(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

interface DayAggFull { cost: number; tokens: number; calls: number; output: number; cacheRead: number; cacheCreation: number; input: number }

function buildStats(
  today: { costUsd: number; tokens: number; output: number; calls: number; cacheRead: number; cacheCreation: number; input: number },
  month: { tokens: number; cacheRead: number; cacheCreation: number; input: number },
  last30: { cacheRead: number; cacheCreation: number; input: number },
  dayOfMonth: number,
  dayAggs14: DayAggFull[],
  speedToday: number[],
  speedByDay: Map<number, number[]>,
  d14: number,
): DashboardData['stats'] {
  const monthDailyAvgTok = month.tokens / dayOfMonth;
  const todayHit = (today.cacheRead + today.cacheCreation + today.input) > 0
    ? (today.cacheRead / (today.cacheRead + today.cacheCreation + today.input)) * 100 : 0;
  const hit30d = (last30.cacheRead + last30.cacheCreation + last30.input) > 0
    ? (last30.cacheRead / (last30.cacheRead + last30.cacheCreation + last30.input)) * 100 : 0;
  const speedMed = median(speedToday);
  const speedP90 = p90(speedToday);
  const avgInPerCall = today.calls > 0 ? (today.input + today.cacheRead + today.cacheCreation) / today.calls : 0;

  // 各卡的 14 天 mini 序列（各用各的指标）
  const hitOfDay = (d: DayAggFull) => {
    const dn = d.cacheRead + d.cacheCreation + d.input;
    return dn > 0 ? (d.cacheRead / dn) * 100 : 0;
  };
  const speedMini: number[] = dayAggs14.map((_, i) => {
    const dayStart = d14 + i * 86400_000;
    return median(speedByDay.get(dayStart) ?? []);
  });

  return {
    tokens: { value: fmtTok(today.tokens), sub: `日均 ${fmtTok(monthDailyAvgTok)}`, mini: dayAggs14.map((d) => d.tokens) },
    output: { value: fmtTok(today.output), sub: today.tokens > 0 ? `占今日总量 ${Math.round((today.output / today.tokens) * 100)}%` : '—', mini: dayAggs14.map((d) => d.output) },
    cacheRead: { value: fmtTok(today.cacheRead), sub: `占读入 ${todayHit.toFixed(1)}%`, mini: dayAggs14.map((d) => d.cacheRead) },
    cacheWrite: { value: fmtTok(today.cacheCreation), sub: '新写进提示缓存', mini: dayAggs14.map((d) => d.cacheCreation) },
    newInput: { value: fmtTok(today.input), sub: '不走缓存的输入', mini: dayAggs14.map((d) => d.input) },
    hitRate: { value: `${hit30d.toFixed(1)}%`, sub: `近 30 天 · 今日 ${todayHit.toFixed(0)}%`, mini: dayAggs14.map(hitOfDay) },
    speed: { value: speedMed.toFixed(1), sub: `中位 ${speedMed.toFixed(1)} · P90 ${speedP90.toFixed(0)} tok/s`, mini: speedMini },
    calls: { value: String(today.calls), sub: `每次读入 ${fmtTok(avgInPerCall)}`, mini: dayAggs14.map((d) => d.calls) },
  };
}

// ---------- 构成 ----------
function mixRows(map: Map<string, { cost: number }>, total: number, fmt?: (k: string) => string): MixRow[] {
  const rows = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const out: MixRow[] = [];
  let rest = 0;
  rows.forEach(([k, v], i) => {
    if (i < 4) out.push({ name: fmt ? fmt(k) : k, costUsd: v.cost, pct: total > 0 ? (v.cost / total) * 100 : 0 });
    else rest += v.cost;
  });
  if (rest > 0) out.push({ name: '其他', costUsd: rest, pct: total > 0 ? (rest / total) * 100 : 0 });
  return out;
}

// ---------- 省钱建议 ----------
function buildSavings(
  events: (UsageEvent & { _costUsd: number })[],
  cfg: TokenPilotConfig,
  pricing: PricingTable,
  sessMap: Map<string, { calls: number; cacheRead: number; cacheCreation: number; input: number; model: string; costUsd: number }>,
  fx: number,
  d7: number,
  _t0: number,
): SavingsCard[] {
  const cards: SavingsCard[] = [];
  const weekEvents = events.filter((e) => e.timestamp >= d7);

  // 1) 打转检测（近 7 天，阈值放宽到 30 次）
  const alerts = detectRetryLoops(weekEvents, (m, u) => costOf(m, u, pricing), { minCallsPerSession: 30, minCostUsd: 0.3 });
  if (alerts.length > 0) {
    // 浪费 ≈ 超出前 30 次调用的那部分成本
    let waste = 0; let totalCalls = 0;
    for (const a of alerts.slice(0, 5)) {
      const sessEvents = weekEvents.filter((e) => e.sessionId === a.sessionId && e.agent === a.agent);
      sessEvents.forEach((e, i) => { if (i >= 30) waste += e._costUsd; });
      totalCalls += a.calls;
    }
    const wasteCny = waste * fx;
    cards.push({
      kind: 'warn', icon: 'retry', title: '检测到打转',
      desc: `${alerts.length} 个会话出现重复重试共 ${totalCalls} 次，浪费 ${fmtCny(wasteCny)}。常见于工具报错后原地重试，建议人工介入。`,
      amount: `−${fmtCny(wasteCny)}`,
    });
  }

  // 2) 模型迁移建议（近 30 天）
  const advice = savingsAdvice(events)[0];
  if (advice) {
    cards.push({
      kind: 'info', icon: 'route', title: '模型迁移建议',
      desc: `${advice.observation}。${advice.suggestion}。`,
      amount: `约省 ${fmtCny(advice.estimatedSavingsUsdPerMonth * fx)}/月`,
    });
  }

  // 3) 缓存优化空间（近 7 天低命中会话）
  let lowN = 0; let lowHit = 1; let saveWeekUsd = 0;
  for (const s of sessMap.values()) {
    const totalIn = s.cacheRead + s.cacheCreation + s.input;
    if (s.calls < 10 || totalIn <= 0) continue;
    const hit = s.cacheRead / totalIn;
    if (hit >= 0.6) continue;
    lowN++;
    lowHit = Math.min(lowHit, hit);
    const p = priceFor(s.model, pricing);
    const missed = (0.95 - hit) * totalIn;
    saveWeekUsd += (missed / 1_000_000) * Math.max(p.input - (p.cacheRead ?? p.input * 0.1), 0);
  }
  if (lowN > 0 && saveWeekUsd > 0.01) {
    cards.push({
      kind: 'pos', icon: 'cache', title: '缓存优化空间',
      desc: `${lowN} 个会话命中率仅 ${Math.round(lowHit * 100)}%，稳定系统提示词并复用会话可恢复到 95% 水平。`,
      amount: `${fmtCny(saveWeekUsd * fx)}/周`,
    });
  }

  void cfg;
  return cards.slice(0, 3);
}

// ---------- 设置 ----------
function buildSettings(
  events: UsageEvent[],
  cfg: TokenPilotConfig,
  pricing: PricingTable,
  fx: number,
  d30: number,
): SettingsData {
  // 近 30 天出现过的模型（按花费降序）∪ 用户覆写
  const costByModel = new Map<string, number>();
  for (const e of events) {
    if (e.timestamp < d30) continue;
    costByModel.set(e.model, (costByModel.get(e.model) ?? 0) + 1);
  }
  const names = [...costByModel.keys()];
  for (const k of Object.keys(cfg.priceOverrides ?? {})) {
    if (!names.includes(k)) names.push(k);
  }
  const models = names.slice(0, 12).map((name) => {
    const p = priceFor(name, pricing);
    const cr = p.cacheRead ?? p.input * 0.1;
    return {
      name,
      inputCny: Math.round(p.input * fx * 100) / 100,
      outputCny: Math.round(p.output * fx * 100) / 100,
      cacheReadCny: Math.round(cr * fx * 100) / 100,
    };
  });
  return {
    models,
    cloudApis: cfg.cloudApis ?? [],
    subscriptions: cfg.subscriptions ?? [],
    monthlyBudgetCny: monthlyBudgetCny(cfg) ?? null,
    usdToCny: fx,
  };
}
