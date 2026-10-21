// 采集器 — 磁盘增量缓存 + 单飞锁
//
// 卡死教训：CLI sync 每次冷启动全量扫 ~2GB 日志（实测 7s 满 CPU），
// 菜单栏 60s 定时器叠加 spawn → 多进程堆积 → IO/CPU 雪崩。
// 修复：
//   1. 磁盘缓存 events-cache.json——文件 mtime 没变就复用缓存事件，只重解析变化的文件
//   2. 单飞锁 sync.lock——已有 sync 在跑就直接跳过
//   3. 缓存窗口 40 天（看板最远用到近 30 天 + 本月）

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UsageEvent } from './schema.ts';
import type { Adapter } from '../adapters/types.ts';
import { claudeCodeAdapter } from '../adapters/claude-code.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { kimiCodeAdapter } from '../adapters/kimi-code.ts';
import { CONFIG_DIR } from './config.ts';

export const ALL_ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, kimiCodeAdapter];

export interface CollectResult {
  events: UsageEvent[];
  detected: string[];
}

const CACHE_PATH = path.join(CONFIG_DIR, 'events-cache.json');
const LOCK_PATH = path.join(CONFIG_DIR, 'sync.lock');
const WINDOW_MS = 40 * 86400_000;
const LOCK_TTL_MS = 120_000;

// ---------- 单飞锁 ----------
export async function acquireSyncLock(): Promise<boolean> {
  try {
    const raw = await fs.readFile(LOCK_PATH, 'utf8');
    const lock = JSON.parse(raw) as { pid?: number; ts?: number };
    const fresh = typeof lock.ts === 'number' && Date.now() - lock.ts < LOCK_TTL_MS;
    if (fresh && typeof lock.pid === 'number') {
      try {
        process.kill(lock.pid, 0); // 进程还在
        return false;              // 有人在跑，跳过
      } catch {
        // 进程死了，锁是僵尸，接管
      }
    }
  } catch {
    // 无锁文件
  }
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
  return true;
}

export async function releaseSyncLock(): Promise<void> {
  try { await fs.unlink(LOCK_PATH); } catch { /* 已不在 */ }
}

// ---------- 磁盘缓存 ----------
interface CacheFileEntry {
  mtime: number;
  adapter: string;
  events: UsageEvent[];
}
interface CacheFile {
  version: 1;
  files: Record<string, CacheFileEntry>;
}

async function loadCache(): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const c = JSON.parse(raw) as CacheFile;
    if (c.version === 1 && c.files) return c;
  } catch { /* 无缓存 */ }
  return { version: 1, files: {} };
}

async function saveCache(cache: CacheFile): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const tmp = CACHE_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fs.rename(tmp, CACHE_PATH);
}

// 带缓存的采集：mtime 不变的文件直接复用缓存事件
export async function collectCached(sinceMs = 0): Promise<CollectResult & { parsedFiles: number; cachedFiles: number }> {
  const cache = await loadCache();
  const windowStart = Math.max(sinceMs, Date.now() - WINDOW_MS);
  const nextFiles: Record<string, CacheFileEntry> = {};
  const detected: string[] = [];
  let parsed = 0;
  let cached = 0;

  for (const ad of ALL_ADAPTERS) {
    if (!(await ad.detect())) continue;
    detected.push(ad.meta.displayName);

    if (ad.listFiles && ad.readFileEvents) {
      let files: string[] = [];
      try { files = await ad.listFiles(); } catch { continue; }
      await Promise.all(files.map(async (f) => {
        let mtime = 0;
        try { mtime = (await fs.stat(f)).mtimeMs; } catch { return; }
        const prev = cache.files[f];
        if (prev && prev.adapter === ad.meta.id && prev.mtime === mtime) {
          nextFiles[f] = prev;
          cached++;
          return;
        }
        const events = await ad.readFileEvents!(f, windowStart);
        nextFiles[f] = { mtime, adapter: ad.meta.id, events };
        parsed++;
      }));
    } else {
      // 无文件级能力的 adapter：全量读（目前没有这种）
      try {
        const events = await ad.readEvents(windowStart);
        nextFiles[`__whole__:${ad.meta.id}`] = { mtime: Date.now(), adapter: ad.meta.id, events };
      } catch { /* 单 adapter 失败不阻塞 */ }
    }
  }

  // 合并 + 按 agent:eventId 去重（取 totalTokens 最大，防流式快照残留）+ 窗口过滤
  const byId = new Map<string, UsageEvent>();
  for (const entry of Object.values(nextFiles)) {
    for (const e of entry.events) {
      if (e.timestamp < sinceMs) continue;
      const key = `${e.agent}:${e.eventId}`;
      const prev = byId.get(key);
      if (!prev || e.usage.totalTokens > prev.usage.totalTokens) byId.set(key, e);
    }
  }

  // 写缓存（下次 sync 提速）
  try { await saveCache({ version: 1, files: nextFiles }); } catch { /* 缓存失败不阻塞 */ }

  return { events: [...byId.values()], detected, parsedFiles: parsed, cachedFiles: cached };
}

// 无缓存全量（today/month/report 命令的直读路径）
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

// 常驻内存增量采集器（serve 用）：启动走磁盘缓存，之后内存增量合并，全量降频 30min
export class Collector {
  private byId = new Map<string, UsageEvent>();
  private lastFull = 0;

  async sync(): Promise<{ events: UsageEvent[]; detected: string[] }> {
    const now = Date.now();
    const wantFull = this.byId.size === 0 || now - this.lastFull > 30 * 60_000;
    // 全量分支抢锁：CLI sync 在跑就让路，退化为增量，绝不叠加全量扫描
    if (wantFull && (await acquireSyncLock())) {
      try {
        const { events, detected } = await collectCached(0);
        this.byId = new Map(events.map((e) => [`${e.agent}:${e.eventId}`, e]));
        this.lastFull = now;
        return { events, detected };
      } finally {
        await releaseSyncLock();
      }
    }
    const since = now - 3 * 60_000; // 增量窗口留 3 分钟重叠
    const { events, detected } = await collectAll(since);
    for (const e of events) {
      this.byId.set(`${e.agent}:${e.eventId}`, e);
    }
    return { events: [...this.byId.values()], detected };
  }
}
