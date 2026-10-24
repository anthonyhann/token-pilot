// 打转熔断通知：每会话每天最多一次（冷却持久化）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { notifyRetryLoops } from '../src/core/breaker.ts';

const STATE = '/Users/hanqiang/.token-pilot/alerted-sessions.json';
const bak = existsSync(STATE) ? JSON.parse(require('node:fs').readFileSync(STATE, 'utf8')) : null;

test('同一会话当天只通知一次', () => {
  const alerts = [{ sessionId: 'test-sess-1', agent: 'claude-code', model: 'm', calls: 50, totalCostUsd: 2 }];
  const first = notifyRetryLoops(alerts);
  const second = notifyRetryLoops(alerts);
  assert.equal(first, 1);
  assert.equal(second, 0, '冷却期内不再重复通知');
});

test('不同会话各自计冷却', () => {
  const alerts = [
    { sessionId: 'test-sess-1', agent: 'claude-code', model: 'm', calls: 50, totalCostUsd: 2 },
    { sessionId: 'test-sess-2', agent: 'codex', model: 'm', calls: 60, totalCostUsd: 3 },
  ];
  const n = notifyRetryLoops(alerts);
  assert.equal(n, 1, 'sess-1 冷却中，sess-2 应新通知');
});

test.after(() => {
  if (bak) writeFileSync(STATE, JSON.stringify(bak));
  else rmSync(STATE, { force: true });
});
