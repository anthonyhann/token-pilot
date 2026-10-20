// 省钱建议 — 事后分析（不拦截、不代理），符合"少采集/本地化"原则
// 逻辑：检测到贵模型在做轻量任务 → 建议换便宜模型，估算能省多少

import type { UsageEvent } from './schema.ts';
import { priceFor } from './pricing.ts';

export interface SavingsAdvice {
  observation: string;
  suggestion: string;
  estimatedSavingsUsdPerMonth: number;
}

// 找"贵模型干轻活"的浪费：贵模型的高频低输出调用
export function savingsAdvice(events: UsageEvent[]): SavingsAdvice[] {
  const advice: SavingsAdvice[] = [];

  // 按模型聚合
  const byModel = new Map<string, { events: number; outputTokens: number; cost: number }>();
  for (const e of events) {
    const m = byModel.get(e.model) ?? { events: 0, outputTokens: 0, cost: 0 };
    m.events++;
    m.outputTokens += e.usage.outputTokens;
    m.cost += 0; // cost 由调用方算，这里先记事件数
    byModel.set(e.model, m);
  }

  // 找最贵的模型
  const models = [...byModel.keys()];
  const expensive = models
    .map((m) => ({ m, p: priceFor(m) }))
    .filter((x) => x.p.output >= 15)
    .sort((a, b) => b.p.output - a.p.output);

  for (const { m, p } of expensive) {
    const agg = byModel.get(m)!;
    // 平均每次调用 output 很少（<500 token）说明是轻量任务
    const avgOut = agg.events > 0 ? agg.outputTokens / agg.events : 0;
    if (avgOut < 500 && agg.events > 100) {
      // 找一个便宜替代
      const cheaper = models
        .map((mm) => ({ mm, p: priceFor(mm) }))
        .filter((x) => x.p.output < p.output * 0.4)
        .sort((a, b) => a.p.output - b.p.output)[0];
      if (cheaper) {
        const cheapCost = agg.events * ((agg.outputTokens / agg.events / 1_000_000) * cheaper.p.output);
        advice.push({
          observation: `${m} 有 ${agg.events} 次调用，平均每次只输出 ${avgOut.toFixed(0)} token（轻量任务）`,
          suggestion: `这类轻量任务可换 ${cheaper.mm}，输出单价 $${p.output} → $${cheaper.p.output}/1M`,
          estimatedSavingsUsdPerMonth: Math.max(0, (agg.events * avgOut / 1_000_000) * (p.output - cheaper.p.output)),
        });
      }
    }
  }
  return advice;
}
