// 定价表加载 + 成本核算
// 价格表内部统一 USD/1M tokens；CNY 目录价加载时按汇率折算。
// DeepSeek 分时定价：peak/offpeak 两档，按事件时间戳（北京时间）选档。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsageTokens, UsageCost } from './schema.ts';
import type { PriceOverrideCny } from './config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TierPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface ModelPrice extends TierPrice {
  provider: string;
  currency?: 'USD' | 'CNY';    // 官方目录价币种（默认 USD）
  peak?: TierPrice;            // DeepSeek 分时用
  offpeak?: TierPrice;
  _alias?: string;             // 别名指向
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

// CNY 目录价 → USD（按给定汇率），_alias 展开
export function loadPricingNormalized(usdToCny = 7.2): PricingTable {
  const base = loadPricing();
  const out: Record<string, ModelPrice> = {};
  for (const [name, p] of Object.entries(base.models)) {
    if (p._alias) {
      const target = base.models[p._alias];
      if (target) out[name] = { ...target, _alias: undefined };
      continue;
    }
    if (p.currency === 'CNY') {
      const cvt = (t?: TierPrice): TierPrice | undefined =>
        t ? {
          input: t.input / usdToCny,
          output: t.output / usdToCny,
          cacheRead: t.cacheRead != null ? t.cacheRead / usdToCny : undefined,
          cacheCreation: t.cacheCreation != null ? t.cacheCreation / usdToCny : undefined,
        } : undefined;
      out[name] = {
        ...p,
        ...(cvt(p) as TierPrice),
        peak: cvt(p.peak),
        offpeak: cvt(p.offpeak),
      };
    } else {
      out[name] = p;
    }
  }
  return { models: out, fallback: base.fallback };
}

// 合并用户覆写价（CNY/1M → USD/1M），覆写优先于自动补价
export function loadPricingWithOverrides(
  overrides?: Record<string, PriceOverrideCny>,
  usdToCny = 7.2,
): PricingTable {
  const base = loadPricingNormalized(usdToCny);
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

// ---------- DeepSeek 分时 ----------
// 中国法定节假日 2026（国务院公布口径；近似即可，量级影响小）
const CN_HOLIDAYS_2026 = new Set([
  '01-01', '01-02', '01-03',                                    // 元旦
  '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', // 春节
  '04-04', '04-05', '04-06',                                    // 清明
  '05-01', '05-02', '05-03', '05-04', '05-05',                  // 劳动节
  '06-19', '06-20', '06-21',                                    // 端午
  '09-25', '09-26', '09-27',                                    // 中秋
  '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', // 国庆
]);

export function isDeepSeekPeak(atMs: number): boolean {
  // 北京时间（UTC+8，无夏令时）
  const d = new Date(atMs + 8 * 3600_000);
  const dow = d.getUTCDay(); // 0=周日
  if (dow === 0 || dow === 6) return false;
  const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  if (CN_HOLIDAYS_2026.has(mmdd)) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (mins >= 9 * 60 && mins < 12 * 60) || (mins >= 14 * 60 && mins < 18 * 60);
}

// 精确匹配 → 别名 → 大小写归一 → 前缀匹配 → fallback
// 分时定价条目（peak/offpeak）无时间戳时以 offpeak 平铺（展示口径；计费请走 costOf 带时间戳）
export function priceFor(model: string, table: PricingTable = loadPricing()): ModelPrice {
  const flatten = (e: ModelPrice): ModelPrice => {
    let r = e._alias && table.models[e._alias] ? table.models[e._alias] : e;
    if ((r.peak || r.offpeak) && r.input === undefined) {
      const t = r.offpeak ?? r.peak!;
      r = { ...r, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation };
    }
    return r;
  };
  const direct = table.models[model];
  if (direct) return flatten(direct);
  const lower = model.toLowerCase();
  for (const k of Object.keys(table.models)) {
    if (k.toLowerCase() === lower) return flatten(table.models[k]);
  }
  const key = Object.keys(table.models).find((k) => lower.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(lower));
  if (key) return flatten(table.models[key]);
  return table.fallback;
}

// 该模型是否有已知价（精确/别名/大小写/前缀命中）；false = 会落到 fallback
export function hasKnownPrice(model: string, table: PricingTable = loadPricing()): boolean {
  if (table.models[model]) return true;
  const lower = model.toLowerCase();
  if (Object.keys(table.models).some((k) => k.toLowerCase() === lower)) return true;
  return Object.keys(table.models).some((k) => lower.startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(lower));
}

// atMs：事件时间戳——分时定价模型（DeepSeek）按它选 peak/offpeak 档
// 本地模型（.gguf 文件路径）零费用——只记用量不计价
export function costOf(model: string, usage: UsageTokens, table?: PricingTable, atMs?: number): UsageCost {
  if (model.endsWith('.gguf') || model.startsWith('/')) {
    return { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreationUsd: 0, totalUsd: 0 };
  }
  let p = priceFor(model, table);
  if (atMs && (p.peak || p.offpeak)) {
    const tier = isDeepSeekPeak(atMs) ? p.peak : p.offpeak;
    if (tier) p = { ...p, ...tier };
  }
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
