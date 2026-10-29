// 额度聚合入口
//
// 设计约束：
//   1. 单个平台失败不影响其它平台（per-provider error isolation）
//   2. 5 分钟缓存，避免每次刷新看板都去请求外部接口
//   3. 缓存文件独立于账单数据——账单是确定性计算结果，额度是外部瞬时快照，
//      混在一起会让对账逻辑变复杂

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';
import type { ProviderQuota, QuotaSnapshot } from './types.js';
import { fetchVolcQuota } from './providers/volc.js';
import { fetchOpencodeQuota } from './providers/opencode.js';
import { fetchDeepseekBalance, fetchGlmQuota, fetchMinimaxTokenPlan } from './providers/balance.js';

const CACHE_PATH = path.join(CONFIG_DIR, 'quota-cache.json');
const TTL_MS = 5 * 60_000;

export async function collectQuota(force = false): Promise<QuotaSnapshot> {
  if (!force) {
    const cached = readCache();
    if (cached) return { ...cached, cached: true };
  }

  // 目前只有火山有 provider；后续平台在这里追加
  const tasks: Promise<ProviderQuota>[] = [
    fetchVolcQuota(),
    fetchOpencodeQuota(),
    fetchDeepseekBalance(),
    fetchGlmQuota(),
    fetchMinimaxTokenPlan(),
  ];

  // allSettled：一个平台抛异常不拖垮其它
  const settled = await Promise.allSettled(tasks);
  const providers: ProviderQuota[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          id: `unknown-${i}`,
          displayName: '未知平台',
          source: 'api' as const,
          ok: false,
          error: String(r.reason).slice(0, 200),
          fetchedAt: Date.now(),
        },
  );

  const snap: QuotaSnapshot = { generatedAt: Date.now(), providers };
  writeCache(snap);
  return snap;
}

function readCache(): QuotaSnapshot | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const d = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as QuotaSnapshot;
    if (!d.generatedAt || Date.now() - d.generatedAt > TTL_MS) return null;
    return d;
  } catch {
    return null;
  }
}

function writeCache(snap: QuotaSnapshot): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(snap), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}
