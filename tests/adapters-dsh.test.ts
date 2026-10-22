// dsh adapter 测试：zstd 压缩 fixture + 步级事件口径

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dshAdapter } from '../src/adapters/dsh.ts';

test('dsh：zstd 解压 + 逐步独立事件 + model 提取 + 全零过滤', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-dsh-'));
  const raw = [
    JSON.stringify({ type: 'rec', seq: 1, time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, totalTokens: 1000 }, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { model: 'kimi-k3' } }] } } }),
    JSON.stringify({ type: 'rec', seq: 2, time: Date.now(), data: { turn: 1, step: 2, usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 950, totalTokens: 1150 }, message: { role: 'assistant', content: [{ model: 'kimi-k3' }] } } }),
    // 全零过滤
    JSON.stringify({ type: 'rec', seq: 3, time: Date.now(), data: { turn: 1, step: 3, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } } }),
    // 无 usage
    JSON.stringify({ type: 'rec', seq: 4, time: Date.now(), data: { turn: 1 } }),
  ].join('\n');
  const zf = path.join(dir, 'session.v4.jsonl.zstd');
  const plain = path.join(dir, 'plain.jsonl');
  writeFileSync(plain, raw);
  execFileSync('zstd', ['-q', '-f', plain, '-o', zf]);

  const events = await dshAdapter.readFileEvents!(zf, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].agent, 'dsh');
  assert.equal(events[0].model, 'kimi-k3');
  assert.equal(events[0].usage.inputTokens, 100);
  assert.equal(events[1].usage.inputTokens, 200);
  // 逐步独立：两步都保留（不是取最大）
  assert.ok(events[0].eventId !== events[1].eventId);
  rmSync(dir, { recursive: true, force: true });
});
