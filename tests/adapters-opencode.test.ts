// OpenCode adapter 测试：建临时 SQLite fixture，验证口径（input 不并入缓存、role 过滤、modelID 提取）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opencodeAdapter } from '../src/adapters/opencode.ts';

test('opencode：只取 assistant 带 tokens 的消息，缓存独立计价不并入 input', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-oc-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, data text)`);
  const now = Date.now();
  const rows = [
    // 正常 assistant 事件
    ['m1', 's1', now, JSON.stringify({ role: 'assistant', modelID: 'glm-5.3-flash', providerID: 'mccodex', path: { cwd: '/proj' }, tokens: { total: 1000, input: 300, output: 200, cache: { write: 0, read: 500 } } })],
    // user 消息（应过滤）
    ['m2', 's1', now, JSON.stringify({ role: 'user', tokens: { total: 10, input: 10, output: 0 } })],
    // assistant 无 tokens（应过滤）
    ['m3', 's1', now, JSON.stringify({ role: 'assistant' })],
    // 全零 tokens（应过滤）
    ['m4', 's1', now, JSON.stringify({ role: 'assistant', tokens: { total: 0, input: 0, output: 0, cache: { read: 0, write: 0 } } })],
  ];
  for (const r of rows) db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(...(r as [string, string, number, string]));
  db.close();

  const events = await opencodeAdapter.readFileEvents!(dbPath, 0);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.model, 'glm-5.3-flash');
  assert.equal(e.usage.inputTokens, 300);         // 不并入 cacheRead
  assert.equal(e.usage.cacheReadTokens, 500);
  assert.equal(e.usage.totalTokens, 1000);
  assert.equal(e.workspace, '/proj');
  rmSync(dir, { recursive: true, force: true });
});
