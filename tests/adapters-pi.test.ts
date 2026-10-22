// pi / volc-ark adapter 测试

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { piAdapter } from '../src/adapters/pi.ts';

test('pi：只取 role=assistant 且有非零 usage 的消息；全零（代理常见）不计', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-pi-'));
  const f = path.join(dir, 'sess1.jsonl');
  const now = new Date().toISOString();
  writeFileSync(f, [
    JSON.stringify({ type: 'session', id: 's1', timestamp: now }),
    JSON.stringify({ type: 'message', id: 'a1', timestamp: now, message: { role: 'assistant', model: 'gpt-5.4', provider: 'mccodex', usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0 } } }),
    // 全零（coding-plan 代理常见）——应过滤
    JSON.stringify({ type: 'message', id: 'a2', timestamp: now, message: { role: 'assistant', model: 'ark-code-latest', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }),
    // user 消息——应过滤
    JSON.stringify({ type: 'message', id: 'u1', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    '',
  ].join('\n'));

  const events = await piAdapter.readFileEvents!(f, 0);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.agent, 'pi');
  assert.equal(e.model, 'gpt-5.4');
  assert.equal(e.usage.inputTokens, 100);
  assert.equal(e.usage.cacheReadTokens, 900);
  assert.equal(e.usage.totalTokens, 1050);
  rmSync(dir, { recursive: true, force: true });
});
