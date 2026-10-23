// 写 metrics-summary.json 给菜单栏/看板读
// 学 LoongSuite Pilot：dataDir/logs/metrics-summary.json

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from './schema.js';
import { costOf } from './pricing.js';

const DATA_DIR = path.join(os.homedir(), '.token-pilot');
const SUMMARY_PATH = path.join(DATA_DIR, 'metrics-summary.json');

export interface MetricsSummary {
  updatedAt: string;
  today: { tokens: number; costUsd: number; events: number };
  month: { tokens: number; costUsd: number; events: number };
  budget?: { monthlyUsd: number; spentUsd: number; percent: number; overspent: boolean };
  byAgent: Record<string, { tokens: number; costUsd: number }>;
  byModel: Record<string, { tokens: number; costUsd: number }>;
}

export function summaryPath(): string {
  return SUMMARY_PATH;
}

export function writeSummary(
  todayEvents: UsageEvent[],
  monthEvents: UsageEvent[],
  budget?: { monthlyUsd: number; spentUsd: number; percent: number; overspent: boolean }
): string {
  function agg(evs: UsageEvent[]) {
    let tokens = 0, costUsd = 0;
    for (const e of evs) {
      tokens += e.usage.totalTokens;
      costUsd += costOf(e.model, e.usage, undefined, e.timestamp).totalUsd;
    }
    return { tokens, costUsd, events: evs.length };
  }
  function group(evs: UsageEvent[], key: 'agent' | 'model') {
    const m: Record<string, { tokens: number; costUsd: number }> = {};
    for (const e of evs) {
      const k = key === 'agent' ? e.agent : e.model;
      const c = m[k] ?? { tokens: 0, costUsd: 0 };
      c.tokens += e.usage.totalTokens;
      c.costUsd += costOf(e.model, e.usage, undefined, e.timestamp).totalUsd;
      m[k] = c;
    }
    return m;
  }

  const summary: MetricsSummary = {
    updatedAt: new Date().toISOString(),
    today: agg(todayEvents),
    month: agg(monthEvents),
    budget,
    byAgent: group(monthEvents, 'agent'),
    byModel: group(monthEvents, 'model'),
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  return SUMMARY_PATH;
}

export function readSummary(): MetricsSummary | null {
  if (!existsSync(SUMMARY_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
  } catch {
    return null;
  }
}
