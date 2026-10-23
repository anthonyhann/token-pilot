// 异常重试/打转检测 — 识别"同一 session 反复重试、token 在烧但没产出"

import type { UsageEvent } from './schema.js';

export interface RetryAlert {
  sessionId: string;
  agent: string;
  model: string;
  calls: number;           // 该 session 的调用次数
  totalTokens: number;
  totalCostUsd: number;
  reason: string;          // 为什么判定为打转
}

export interface RetryDetectOptions {
  minCallsPerSession?: number;   // 一个 session 超过多少次调用算可疑（默认 50）
  minCostUsd?: number;           // 该 session 花费超过多少美元才算（默认 1）
}

// 检测"打转"会话：单个 session 调用次数异常多，往往意味着 Agent 在死循环/重试
export function detectRetryLoops(
  events: UsageEvent[],
  costOfFn: (model: string, usage: UsageEvent['usage']) => { totalUsd: number },
  opts: RetryDetectOptions = {}
): RetryAlert[] {
  const minCalls = opts.minCallsPerSession ?? 50;
  const minCost = opts.minCostUsd ?? 1.0;

  // 按 session 聚合
  const bySession = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const arr = bySession.get(e.sessionId) ?? [];
    arr.push(e);
    bySession.set(e.sessionId, arr);
  }

  const alerts: RetryAlert[] = [];
  for (const [sessionId, evs] of bySession) {
    if (evs.length < minCalls) continue;
    let tokens = 0;
    let cost = 0;
    const models = new Set<string>();
    let agent = '';
    for (const e of evs) {
      tokens += e.usage.totalTokens;
      cost += costOfFn(e.model, e.usage).totalUsd;
      models.add(e.model);
      agent = e.agent;
    }
    if (cost < minCost) continue;

    alerts.push({
      sessionId,
      agent,
      model: [...models].join(','),
      calls: evs.length,
      totalTokens: tokens,
      totalCostUsd: cost,
      reason: `单会话 ${evs.length} 次调用，烧 $${cost.toFixed(2)}，疑似打转/死循环`,
    });
  }
  // 按花费降序
  return alerts.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}
