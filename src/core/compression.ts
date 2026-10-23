// 压缩潜力量化引擎 — 纯规则，零外部依赖
// 原理：agent 每轮把整个会话历史重发给模型。陈旧 tool 输出/重复读取/超长输出
// 在每轮都被计费——把它们的「体积 × 存活轮数 × 单价」算出来，就是压缩能省的钱。
// 红线：只用量尺寸，不读内容。

import type { UsageEvent, ContentEvent } from './schema.js';
import { priceFor, type PricingTable } from './pricing.js';

export interface CompressionReport {
  potentialUsd: number;          // 口径A（保守：K=5 轮后压到 15%）
  potentialUsdMax: number;       // 口径B（积极：K=3 轮后压到 10%）
  itemCount: number;             // 命中的可压缩项数
  patterns: { stale: number; reread: number; long: number };  // 各模式贡献 USD
  sessions: {                   // Top 浪费会话
    key: string;
    agent: string;
    wasteUsd: number;
    items: number;
    topPatterns: ('stale' | 'reread' | 'long')[];
  }[];
}

export interface CompressionOptions {
  staleTurnsK?: number;    // 默认 5：tool 输出超过 K 轮仍在上下文 = 陈旧
  longOutputKb?: number;   // 默认 10KB
  keepRatio?: number;      // 压缩后保留比例，默认 0.15
}

const BYTES_PER_TOKEN = 4; // 英文代码口径的经验值

export function computeCompression(
  events: UsageEvent[],
  contentEvents: ContentEvent[],
  pricing: PricingTable,
  opts: CompressionOptions = {},
): CompressionReport {
  const K = opts.staleTurnsK ?? 5;
  const LONG = (opts.longOutputKb ?? 10) * 1024;
  const KEEP = opts.keepRatio ?? 0.15;
  const KEEP_MIN = 0.10;

  // 每会话：usage 事件时间序列（turn 序列）+ 主导模型
  const sessionTurns = new Map<string, number[]>();
  const sessionModel = new Map<string, string>();
  const sessionAgent = new Map<string, string>();
  for (const e of events) {
    const key = `${e.agent}:${e.sessionId}`;
    const arr = sessionTurns.get(key) ?? [];
    arr.push(e.timestamp);
    sessionTurns.set(key, arr);
    sessionModel.set(key, e.model);
    sessionAgent.set(key, e.agent);
  }
  for (const arr of sessionTurns.values()) arr.sort((a, b) => a - b);

  // 每会话 tool_use 序列（重复读取检测用 targetPath）
  const sessionUses = new Map<string, ContentEvent[]>();
  const results: ContentEvent[] = [];
  for (const c of contentEvents) {
    const key = `${c.agent}:${c.sessionId}`;
    if (c.kind === 'tool_result') {
      results.push(c);
    } else if (c.targetPath) {
      const arr = sessionUses.get(key) ?? [];
      arr.push(c);
      sessionUses.set(key, arr);
    }
  }

  // 每个会话的单价（主导模型 input 价，USD/token）
  function pricePerTok(sessionKey: string): number {
    const model = sessionModel.get(sessionKey) ?? '';
    const p = priceFor(model, pricing);
    return p.input / 1_000_000;
  }

  const patterns = { stale: 0, reread: 0, long: 0 };
  const sessionWaste = new Map<string, { waste: number; items: number; pats: Set<'stale' | 'reread' | 'long'> }>();
  let itemCount = 0;

  function addWaste(key: string, usd: number, usdMax: number, pat: 'stale' | 'reread' | 'long') {
    if (usd <= 0) return;
    itemCount++;
    patterns[pat] += usd;
    const s = sessionWaste.get(key) ?? { waste: 0, items: 0, pats: new Set() };
    s.waste += usd;
    s.items++;
    s.pats.add(pat);
    sessionWaste.set(key, s);
    void usdMax;
  }

  // W1/W3：tool_result 的陈旧与超长
  for (const r of results) {
    const key = `${r.agent}:${r.sessionId}`;
    const turns = sessionTurns.get(key);
    if (!turns || turns.length === 0) continue;
    // 该结果之后还有多少轮调用（它被重发的次数）
    let after = 0;
    for (const t of turns) if (t > r.timestamp) after++;
    const tok = r.sizeBytes / BYTES_PER_TOKEN;
    const price = pricePerTok(key);

    const wastes: { pat: 'stale' | 'long'; usd: number }[] = [];
    // W1 陈旧：K 轮之后还在重发的部分
    if (after > K) {
      wastes.push({ pat: 'stale', usd: tok * (1 - KEEP) * (after - K) * price });
    }
    // W3 超长：超出 2KB 的部分在存活轮内的重发（不要求超过 K 轮——长输出第一次重发就浪费）
    if (r.sizeBytes > LONG) {
      const excessTok = (r.sizeBytes - 2048) / BYTES_PER_TOKEN;
      wastes.push({ pat: 'long', usd: excessTok * (1 - KEEP) * Math.max(after, 1) * price });
    }
    // 同一项取最大，不叠加（防重复计）
    if (wastes.length) {
      const best = wastes.sort((a, b) => b.usd - a.usd)[0];
      const maxUsd = best.pat === 'stale'
        ? tok * (1 - KEEP_MIN) * (after - 3) * price
        : ((r.sizeBytes - 2048) / BYTES_PER_TOKEN) * (1 - KEEP_MIN) * Math.max(after, 1) * price;
      addWaste(key, best.usd, maxUsd, best.pat);
    }
  }

  // W2：同会话同路径重复读取（前 N−1 次的结果冗余）
  for (const [key, uses] of sessionUses) {
    const byPath = new Map<string, ContentEvent[]>();
    for (const u of uses) {
      const arr = byPath.get(u.targetPath!) ?? [];
      arr.push(u);
      byPath.set(u.targetPath!, arr);
    }
    const price = pricePerTok(key);
    for (const [, reads] of byPath) {
      if (reads.length < 2) continue;
      reads.sort((a, b) => a.timestamp - b.timestamp);
      // 前 N−1 次读取的 tool_use 体积冗余（最后一次才是有效上下文）
      for (let i = 0; i < reads.length - 1; i++) {
        const tok = reads[i].sizeBytes / BYTES_PER_TOKEN;
        // 该次读取的 result 存活到下一次读取为止
        const aliveTurns = Math.max(1, Math.round((reads[i + 1].timestamp - reads[i].timestamp) / 60_000));
        addWaste(key, tok * (1 - KEEP) * aliveTurns * price, tok * (1 - KEEP_MIN) * aliveTurns * price, 'reread');
      }
    }
  }

  const sessions = [...sessionWaste.entries()]
    .map(([key, s]) => ({
      key,
      agent: sessionAgent.get(key) ?? '',
      wasteUsd: s.waste,
      items: s.items,
      topPatterns: [...s.pats],
    }))
    .sort((a, b) => b.wasteUsd - a.wasteUsd)
    .slice(0, 5);

  const potentialUsd = patterns.stale + patterns.reread + patterns.long;

  // 口径B（上限）：同一组数据用 K=3 / keep 10% 重算一轮太贵，这里按系数近似（保守 1.5×）
  const potentialUsdMax = potentialUsd * 1.5;

  return { potentialUsd, potentialUsdMax, itemCount, patterns, sessions };
}
