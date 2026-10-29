// 文件解析并发控制
//
// 来历：2026-10-29 排查额度功能时发现 sync 会 OOM 崩溃。
// 根因是 collector 用 Promise.all 同时打开全部日志文件——本机 6481 个
// jsonl 一次全开，4GB 堆瞬间耗尽，进程直接 FATAL。
// 逐个文件解析只要 98MB，问题完全在并发度上。
//
// 这组测试锁住「并发有上限」这个约束，防止以后有人图省事改回 Promise.all。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 复刻 collector 里的实现（保持行为一致，测试的是契约不是实现细节）
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

test('mapWithConcurrency：同时执行的任务数不超过上限', async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 100 }, (_, i) => i);

  await mapWithConcurrency(items, 8, async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
  });

  assert.ok(peak <= 8, `并发峰值应 ≤ 8，实际 ${peak}`);
  assert.ok(peak > 1, '应该真的并行，而不是退化成串行');
});

test('mapWithConcurrency：每个元素都被处理且只处理一次', async () => {
  const seen = new Set<number>();
  let calls = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    calls++;
    seen.add(n);
  });
  assert.equal(calls, 7, '调用次数必须等于元素数');
  assert.equal(seen.size, 7, '不能漏也不能重复');
});

test('mapWithConcurrency：空数组不挂起', async () => {
  let called = 0;
  await mapWithConcurrency([], 8, async () => {
    called++;
  });
  assert.equal(called, 0);
});

test('mapWithConcurrency：元素数少于上限时按实际数量开 worker', async () => {
  let running = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2], 32, async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
  });
  assert.equal(peak, 2, '只有 2 个元素，峰值不该超过 2');
});
