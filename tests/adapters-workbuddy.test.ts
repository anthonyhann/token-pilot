// workbuddy adapter 测试：trace_end.summary.modelInfo 口径

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workbuddyAdapter } from '../src/adapters/workbuddy.ts';

test('workbuddy：trace_end modelInfo 拆分（input 不含 cached），全零/缺 modelInfo 过滤', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-wb-'));
  const f = path.join(dir, 'trace_x.jsonl');
  const now = new Date().toISOString();
  writeFileSync(f, [
    JSON.stringify({ type: 'trace_start', trace: { traceId: 't1' } }),
    // 正常：input=1000, cached=800, output=100 → fresh input 应为 200
    JSON.stringify({ type: 'trace_end', summary: { sessionId: 's1', endedAt: now, modelInfo: { models: ['hy3'], totalInputTokens: 1000, totalCachedTokens: 800, totalOutputTokens: 100, callCount: 5 } } }),
    // 全零过滤
    JSON.stringify({ type: 'trace_end', summary: { sessionId: 's2', endedAt: now, modelInfo: { models: ['hy3'], totalInputTokens: 0, totalCachedTokens: 0, totalOutputTokens: 0, callCount: 0 } } }),
    // 无 modelInfo 过滤
    JSON.stringify({ type: 'trace_end', summary: { sessionId: 's3', endedAt: now } }),
  ].join('\n'));

  const events = await workbuddyAdapter.readFileEvents!(f, 0);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.agent, 'workbuddy');
  assert.equal(e.model, 'hy3');
  assert.equal(e.provider, 'hunyuan');
  assert.equal(e.usage.inputTokens, 200);
  assert.equal(e.usage.cacheReadTokens, 800);
  assert.equal(e.usage.outputTokens, 100);
  rmSync(dir, { recursive: true, force: true });
});
