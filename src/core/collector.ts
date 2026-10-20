// 采集器 — 全量/增量采集，按 agent:eventId 去重合并

import type { UsageEvent } from './schema.ts';
import type { Adapter } from '../adapters/types.ts';
import { claudeCodeAdapter } from '../adapters/claude-code.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { kimiCodeAdapter } from '../adapters/kimi-code.ts';

export const ALL_ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, kimiCodeAdapter];

export interface CollectResult {
  events: UsageEvent[];
  detected: string[];
}

export async function collectAll(sinceMs = 0): Promise<CollectResult> {
  const all: UsageEvent[] = [];
  const detected: string[] = [];
  for (const ad of ALL_ADAPTERS) {
    if (!(await ad.detect())) continue;
    detected.push(ad.meta.displayName);
    try {
      all.push(...(await ad.readEvents(sinceMs)));
    } catch {
      // 单 adapter 失败不阻塞整体
    }
  }
  return { events: all, detected };
}

// 增量采集器：serve 模式常驻，mtime 快跳使增量扫描很便宜
export class Collector {
  private byId = new Map<string, UsageEvent>();
  private lastFull = 0;

  async sync(): Promise<{ events: UsageEvent[]; detected: string[] }> {
    const now = Date.now();
    const full = this.byId.size === 0 || now - this.lastFull > 10 * 60_000;
    const since = full ? 0 : now - 3 * 60_000; // 增量窗口留 3 分钟重叠
    const { events, detected } = await collectAll(since);
    for (const e of events) {
      this.byId.set(`${e.agent}:${e.eventId}`, e);
    }
    if (full) this.lastFull = now;
    return { events: [...this.byId.values()], detected };
  }
}
