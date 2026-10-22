// 定价表加载 + 成本核算
// 价格表内部统一 USD/1M tokens；用户覆写价（设置弹窗，¥/1M）加载时按汇率折算合并。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsageTokens, UsageCost } from './schema.ts';
import type { PriceOverrideCny } from './config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ModelPrice {
  provider: string;
  input: number;         // $/1M tokens
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface PricingTable {
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

// 合并用户覆写价（CNY/1M → USD/1M）
export function loadPricingWithOverrides(
  overrides?: Record<string, PriceOverrideCny>,
  usdToCny = 7.2,
): PricingTable {
  const base = loadPricing();
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const models: Record<string, ModelPrice> = { ...base.models };
  for (const [model, ov] of Object.entries(overrides)) {
    const prev = models[model] ?? { provider: 'custom', input: 0, output: 0 };
    models[model] = {
      provider: prev.provider,
      input: (ov.input ?? 0) / usdToCny,
      output: (ov.output ?? 0) / usdToCny,
      cacheRead: ov.cacheRead != null ? ov.cacheRead / usdToCny : undefined,
      cacheCreation: prev.cacheCreation,
    };
  }
  return { models, fallback: base.fallback };
}

// 该模型是否有已知价（精确/大小写/前缀命中）；false = 会落到 fallback
export function hasKnownPrice(model: string, table: PricingTable = loadPricing()): boolean {
  if (table.models[model]) return true;
  const lower = model.toLowerCase();
  if (Object.keys(table.models).some((k) => k.toLowerCase() === lower)) return true;
  return Object.keys(table.models).some((k) => lower.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(lower));
}

// 精确匹配 → 大小写归一 → 前缀匹配 → fallback
export function priceFor(model: string, table: PricingTable = loadPricing()): ModelPrice {
  if (table.models[model]) return table.models[model];
  const lower = model.toLowerCase();
  const ciKey = Object.keys(table.models).find((k) => k.toLowerCase() === lower);
  if (ciKey) return table.models[ciKey];
  // 前缀匹配：deepseek-v4.1-flash-20260601 → deepseek-v4.1-flash
  const key = Object.keys(table.models).find((k) => lower.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(lower));
  if (key) return table.models[key];
  return table.fallback;
}

export function costOf(model: string, usage: UsageTokens, table?: PricingTable): UsageCost {
  const p = priceFor(model, table);
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

// 缓存相对全价输入省下的钱（用于「缓存帮你省了 ¥x」）
export function cacheSavingsUsd(model: string, cacheReadTokens: number, table?: PricingTable): number {
  const p = priceFor(model, table);
  const full = p.input;
  const hit = p.cacheRead ?? p.input * 0.1;
  return (cacheReadTokens / 1_000_000) * Math.max(full - hit, 0);
}
