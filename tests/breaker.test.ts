// 打转熔断通知：每会话每天最多一次（冷却持久化）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { notifyRetryLoops } from '../src/core/breaker.ts';

const STATE = '/Users/hanqiang/.token-pilot/alerted-sessions.json';
const bak = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;

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
  if (bak) writeFileSync(STATE, JSON.stringify(bak));
  else rmSync(STATE, { force: true });
});
