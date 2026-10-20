// 定价表加载 + 成本核算

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsageTokens, UsageCost } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ModelPrice {
  provider: string;
  input: number;         // $/1M tokens
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

interface PricingTable {
  models: Record<string, ModelPrice>;
  fallback: ModelPrice & { _note?: string };
}

let cached: PricingTable | null = null;

export function loadPricing(): PricingTable {
  if (cached) return cached;
  const p = path.resolve(__dirname, '../../pricing/models.json');
  cached = JSON.parse(readFileSync(p, 'utf8'));
  return cached!;
}

// 精确匹配 → 前缀匹配 → fallback
export function priceFor(model: string): ModelPrice {
  const t = loadPricing();
  if (t.models[model]) return t.models[model];
  // 前缀匹配：deepseek-v4.1-flash-20260601 → deepseek-v4.1-flash
  const key = Object.keys(t.models).find((k) => model.startsWith(k) || k.startsWith(model));
  if (key) return t.models[key];
  // provider 级兜底
  return t.fallback;
}

export function costOf(model: string, usage: UsageTokens): UsageCost {
  const p = priceFor(model);
  const M = 1_000_000;
  const inputUsd = (usage.inputTokens / M) * p.input;
  const outputUsd = (usage.outputTokens / M) * p.output;
  const cacheReadUsd = (usage.cacheReadTokens / M) * (p.cacheRead ?? p.input * 0.1);
  const cacheCreationUsd = (usage.cacheCreationTokens / M) * (p.cacheCreation ?? p.input * 1.25);
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheCreationUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd,
  };
}
