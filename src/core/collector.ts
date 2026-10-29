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
import type { UsageEvent, ContentEvent } from './schema.js';
import type { Adapter } from '../adapters/types.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { codexAdapter } from '../adapters/codex.js';
import { kimiCodeAdapter } from '../adapters/kimi-code.js';
import { opencodeAdapter } from '../adapters/opencode.js';
import { piAdapter } from '../adapters/pi.js';
import { volcArkAdapter } from '../adapters/volc-ark.js';
import { dshAdapter } from '../adapters/dsh.js';
import { workbuddyAdapter, workbuddyAiAdapter } from '../adapters/workbuddy.js';
import { CONFIG_DIR } from './config.js';

export const ALL_ADAPTERS: Adapter[] = [claudeCodeAdapter, codexAdapter, kimiCodeAdapter, opencodeAdapter, piAdapter, volcArkAdapter, dshAdapter, workbuddyAdapter, workbuddyAiAdapter];

export interface CollectResult {
  events: UsageEvent[];
  contentEvents: ContentEvent[];
  detected: string[];
}

const CACHE_PATH = path.join(CONFIG_DIR, 'events-cache.json');
/** 同时打开的文件数上限。SSD 上 32 已经能吃到 IO 带宽，再高只是徒增内存峰值。 */
const FILE_CONCURRENCY = 32;

/** 限并发的 map，保持结果顺序无关（本项目只关心副作用） */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
const LOCK_PATH = path.join(CONFIG_DIR, 'sync.lock');
const WINDOW_MS = 40 * 86400_000;
const LOCK_TTL_MS = 120_000;

// ---------- 单飞锁 ----------
/// 抢锁。返回 true = 抢到了（调用方负责 release）。
///
/// 写锁失败（目录只读、沙箱 EPERM、磁盘满）不能让整次 sync 崩掉：
/// 锁只是防多进程叠加的优化，拿不到就退化成本次不加锁跑——总比看板
/// 直接返回 {} 什么都看不到强。这里吞掉写错误，只在拿不到时返回 true，
/// 由调用方的 finally 里的 release 自行忽略"文件不存在"。
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
    // 无锁文件（或读不到）
  }
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
  } catch {
    // 写不了锁文件：不加锁也要继续，不能因为锁而拿不到数据
  }
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
  content?: ContentEvent[];
}
interface CacheFile {
  version: 2;
  files: Record<string, CacheFileEntry>;
}

async function loadCache(): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const c = JSON.parse(raw) as CacheFile;
    if (c.version === 2 && c.files) return c;
  } catch { /* 无缓存 */ }
  return { version: 2, files: {} };
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
      // 并发上限：曾经直接 Promise.all 全部文件，6481 个 jsonl 同时打开会瞬间
      // 耗尽 4GB 堆导致 sync 直接 OOM 崩溃（本机实测，2026-10-29）。
      // 限流后逐个文件的内存占用能被 GC 及时回收，峰值降到百 MB 量级。
      await mapWithConcurrency(files, FILE_CONCURRENCY, async (f) => {
        let mtime = 0;
        try { mtime = (await fs.stat(f)).mtimeMs; } catch { return; }
        const prev = cache.files[f];
        if (prev && prev.adapter === ad.meta.id && prev.mtime === mtime) {
          nextFiles[f] = prev;
          cached++;
          return;
        }
        const events = await ad.readFileEvents!(f, windowStart);
        // 内容流（压缩潜力用）：有能力的 adapter 顺手采，只取尺寸不落内容
        let contentEv: ContentEvent[] | undefined;
        if (ad.readFileContentEvents) {
          try { contentEv = await ad.readFileContentEvents(f, windowStart); } catch { contentEv = undefined; }
        }
        nextFiles[f] = { mtime, adapter: ad.meta.id, events, content: contentEv };
        parsed++;
      });
    } else {
      // 无文件级能力的 adapter：全量读（目前没有这种）
      try {
        const events = await ad.readEvents(windowStart);
        nextFiles[`__whole__:${ad.meta.id}`] = { mtime: Date.now(), adapter: ad.meta.id, events };
      } catch { /* 单 adapter 失败不阻塞 */ }
    }
  }

  // 合并 + 按 agent:eventId 去重（取 totalTokens 最大，防流式快照残留）+ 窗口过滤
  const contentAll: ContentEvent[] = [];
  const byId = new Map<string, UsageEvent>();
  for (const entry of Object.values(nextFiles)) {
    if (entry.content) {
      for (const c of entry.content) if (c.timestamp >= sinceMs) contentAll.push(c);
    }
    for (const e of entry.events) {
      if (e.timestamp < sinceMs) continue;
      const key = `${e.agent}:${e.eventId}`;
      const prev = byId.get(key);
      if (!prev || e.usage.totalTokens > prev.usage.totalTokens) byId.set(key, e);
    }
  }

  // 写缓存（下次 sync 提速）
  try { await saveCache({ version: 2, files: nextFiles }); } catch { /* 缓存失败不阻塞 */ }

  return { events: [...byId.values()], contentEvents: contentAll, detected, parsedFiles: parsed, cachedFiles: cached };
}

// 无缓存全量（today/month/report 命令的直读路径）
export async function collectAll(sinceMs = 0): Promise<CollectResult> {
  const all: UsageEvent[] = [];
  const contentAll: ContentEvent[] = [];
  const detected: string[] = [];
  for (const ad of ALL_ADAPTERS) {
    if (!(await ad.detect())) continue;
    detected.push(ad.meta.displayName);
    try {
      all.push(...(await ad.readEvents(sinceMs)));
    } catch {
      // 单 adapter 失败不阻塞整体
    }
    if (ad.listFiles && ad.readFileContentEvents) {
      try {
        for (const f of await ad.listFiles()) {
          try {
            const st = await fs.stat(f);
            if (st.mtimeMs < sinceMs) continue;
          } catch { continue; }
          contentAll.push(...(await ad.readFileContentEvents(f, sinceMs)));
        }
      } catch { /* 忽略 */ }
    }
  }
  return { events: all, contentEvents: contentAll, detected };
}

// 常驻内存增量采集器（serve 用）：启动走磁盘缓存，之后内存增量合并，全量降频 30min
export class Collector {
  private byId = new Map<string, UsageEvent>();
  private lastFull = 0;

  async sync(): Promise<{ events: UsageEvent[]; contentEvents: ContentEvent[]; detected: string[] }> {
    const now = Date.now();
    const wantFull = this.byId.size === 0 || now - this.lastFull > 30 * 60_000;
    // 全量分支抢锁：CLI sync 在跑就让路，退化为增量，绝不叠加全量扫描
    if (wantFull && (await acquireSyncLock())) {
      try {
        const { events, contentEvents, detected } = await collectCached(0);
        this.byId = new Map(events.map((e) => [`${e.agent}:${e.eventId}`, e]));
        this.lastFull = now;
        return { events, contentEvents, detected };
      } finally {
        await releaseSyncLock();
      }
    }
    const since = now - 3 * 60_000; // 增量窗口留 3 分钟重叠
    const { events, contentEvents, detected } = await collectAll(since);
    for (const e of events) {
      this.byId.set(`${e.agent}:${e.eventId}`, e);
    }
    return { events: [...this.byId.values()], contentEvents, detected };
  }
}
