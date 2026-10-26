// 打转熔断通知：每会话每天最多一次（冷却持久化）
// 状态目录通过 TOKEN_PILOT_HOME 隔离到临时目录，不碰用户真实的 ~/.token-pilot。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 必须在 import breaker（它经 config 读取 CONFIG_DIR）之前设置
const HOME = mkdtempSync(path.join(tmpdir(), 'token-pilot-test-'));
process.env.TOKEN_PILOT_HOME = HOME;

const { notifyRetryLoops } = await import('../src/core/breaker.ts');

test('同一会话当天只通知一次', () => {
  const alerts = [{ sessionId: 'test-sess-1', agent: 'claude-code', model: 'm', calls: 50, totalCostUsd: 2 }];
  const first = notifyRetryLoops(alerts);
  const second = notifyRetryLoops(alerts);
  assert.equal(first, 1);
  assert.equal(second, 0, '冷却期内不再重复通知');
});

test('每次最多通知 1 个（防轰炸），其余标记不再提', () => {
  const alerts = [
    { sessionId: 'test-sess-3', agent: 'codex', model: 'm', calls: 60, totalCostUsd: 3 },
    { sessionId: 'test-sess-4', agent: 'codex', model: 'm', calls: 50, totalCostUsd: 2 },
  ];
  const n = notifyRetryLoops(alerts);
  assert.equal(n, 1, '只通知最贵的那个');
  const again = notifyRetryLoops(alerts);
  assert.equal(again, 0, '其余会话也已标记，不重复');
});

test.after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
