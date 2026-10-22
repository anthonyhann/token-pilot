// 压缩潜力引擎测试（纯规则）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCompression } from '../src/core/compression.ts';
import type { UsageEvent, ContentEvent } from '../src/core/schema.ts';
import type { PricingTable } from '../src/core/pricing.ts';

const pricing: PricingTable = {
  models: { 'test-model': { provider: 'test', input: 1.0, output: 2.0, cacheRead: 0.1 } },
  fallback: { provider: 'x', input: 1.0, output: 5.0 },
};

const T0 = Date.now() - 3600_000;

function usage(ts: number, session = 's1'): UsageEvent {
  return {
    agent: 'claude-code', sessionId: session, eventId: `u${ts}-${Math.random()}`, timestamp: ts,
    provider: 'test', model: 'test-model',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 150 },
  };
}
function toolResult(ts: number, sizeBytes: number, session = 's1'): ContentEvent {
  return { agent: 'claude-code', sessionId: session, timestamp: ts, kind: 'tool_result', sizeBytes };
}
function toolUse(ts: number, path: string, session = 's1'): ContentEvent {
  return { agent: 'claude-code', sessionId: session, timestamp: ts, kind: 'tool_use', tool: 'Read', targetPath: path, sizeBytes: 100 };
}

test('W1 陈旧输出：K 轮后仍在重发的部分计入', () => {
  // 1 个 tool_result（4KB≈1000 tokens）+ 后面 10 轮调用 → after=10，K=5 → 5 轮陈旧
  const events = [usage(T0), ...Array.from({ length: 10 }, (_, i) => usage(T0 + (i + 1) * 60_000))];
  const content = [toolResult(T0 + 1000, 4000)];
  const r = computeCompression(events, content, pricing);
  assert.ok(r.patterns.stale > 0);
  // 1000 tok × 0.85 × 5 轮 × $1/1M ≈ $0.00425
  assert.ok(Math.abs(r.patterns.stale - 0.00425) < 0.001, `stale=${r.patterns.stale}`);
  assert.equal(r.itemCount, 1);
});

test('W2 重复读取：同路径前 N−1 次读取冗余', () => {
  const events = [usage(T0), usage(T0 + 10 * 60_000), usage(T0 + 20 * 60_000)];
  const content = [toolUse(T0 + 1000, '/a.ts'), toolUse(T0 + 5 * 60_000, '/a.ts'), toolUse(T0 + 15 * 60_000, '/a.ts')];
  const r = computeCompression(events, content, pricing);
  assert.ok(r.patterns.reread > 0, '重复读取应计入');
  assert.ok(r.sessions[0].topPatterns.includes('reread'));
});

test('W3 超长输出：超出 2KB 的部分计入', () => {
  const events = [usage(T0), usage(T0 + 60_000), usage(T0 + 120_000), usage(T0 + 180_000), usage(T0 + 240_000), usage(T0 + 300_000)];
  const content = [toolResult(T0 + 500, 50 * 1024)]; // 50KB
  const r = computeCompression(events, content, pricing);
  assert.ok(r.patterns.long > 0);
});

test('无内容流时不报错返回零', () => {
  const r = computeCompression([usage(T0)], [], pricing);
  assert.equal(r.potentialUsd, 0);
  assert.equal(r.itemCount, 0);
});

test('不叠加：同一项命中多个模式取最大', () => {
  // 超长 + 陈旧同一项
  const events = [usage(T0), ...Array.from({ length: 8 }, (_, i) => usage(T0 + (i + 1) * 60_000))];
  const content = [toolResult(T0 + 500, 30 * 1024)];
  const r = computeCompression(events, content, pricing);
  assert.equal(r.itemCount, 1, '同一项只计一次');
  // stale+long 只入账一个
  const both = [r.patterns.stale > 0, r.patterns.long > 0].filter(Boolean).length;
  assert.equal(both, 1);
});
