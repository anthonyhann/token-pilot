// Adapter 测试：fixtures 驱动，验证去重/过滤/缓存拆分口径

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { codexAdapter } from '../src/adapters/codex.ts';
import { kimiCodeAdapter } from '../src/adapters/kimi-code.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => path.join(__dirname, 'fixtures', name);

test('claude-code：流式快照按 message.id 去重，取最大（全零快照被丢弃）', async () => {
  const events = await claudeCodeAdapter.readFileEvents!(fx('claude-session.jsonl'));
  assert.equal(events.length, 1, '3 行同 id 快照 + 1 synthetic + 1 summary → 1 事件');
  const e = events[0];
  assert.equal(e.eventId, 'msg-dup-1');
  assert.equal(e.usage.outputTokens, 4263);
  assert.equal(e.usage.cacheReadTokens, 93760);
  assert.equal(e.usage.inputTokens, 239);
  assert.equal(e.sessionTitle, '修复登录页样式');
  assert.equal(e.workspace, '/Users/test/myproj');
  assert.equal(e.provider, 'anthropic');
});

test('kimi-code：只认 usage.record；input 只算 inputOther（缓存不重复计）', async () => {
  const events = await kimiCodeAdapter.readFileEvents!(fx('kimi-wire.jsonl'));
  assert.equal(events.length, 2, 'agent.message.appended 里伪造的 usage 不得计入');
  const [e1, e2] = events;
  assert.equal(e1.usage.inputTokens, 42369);
  assert.equal(e1.usage.totalTokens, 42369 + 172);
  assert.equal(e2.usage.cacheReadTokens, 42240);
  assert.equal(e2.usage.totalTokens, 203 + 320 + 42240);
});

test('codex：input 拆出 cached 子集（input − cached）', async () => {
  const events = await codexAdapter.readFileEvents!(fx('codex-rollout.jsonl'));
  assert.equal(events.length, 2, 'response_item 不计');
  const [e1] = events;
  assert.equal(e1.usage.inputTokens, 56369 - 5760);
  assert.equal(e1.usage.cacheReadTokens, 5760);
  // total 语义 = record.total_tokens = input + output
  assert.equal(e1.usage.totalTokens, 56369 + 956);
});
