// 打转熔断通知策略 — 检测到的打转会话主动弹系统通知（每会话每天最多一次，不轰炸）
// 状态落盘 ~/.token-pilot/alerted-sessions.json（CLI sync 是短命进程，必须持久化冷却）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { notify } from './alert.js';

const STATE_PATH = path.join(CONFIG_DIR, 'alerted-sessions.json');
const COOLDOWN_MS = 86400_000; // 每会话每天最多一次

interface AlertedState {
  sessions: Record<string, number>; // sessionKey → lastNotifiedMs
}

function load(): AlertedState {
  if (!existsSync(STATE_PATH)) return { sessions: {} };
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return { sessions: {} }; }
}

function save(s: AlertedState): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s), 'utf8');
}

export interface RetryAlertLike {
  sessionId: string;
  agent: string;
  model: string;
  calls: number;
  totalCostUsd: number;
}

// 对检测到的打转会话发通知；返回新通知的会话数
export function notifyRetryLoops(alerts: RetryAlertLike[], now = Date.now()): number {
  if (alerts.length === 0) return 0;
  const state = load();
  // 每次最多通知 1 个（最严重的）：首次运行不清历史账，防通知轰炸
  const sorted = [...alerts].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  let sent = 0;
  for (const a of sorted) {
    const key = `${a.agent}:${a.sessionId}`;
    const last = state.sessions[key] ?? 0;
    if (now - last < COOLDOWN_MS) continue;
    state.sessions[key] = now;
    notify(
      'token-pilot · 检测到打转',
      `${a.agent} 一个会话重复调用 ${a.calls} 次（烧 ¥${(a.totalCostUsd * 7.2).toFixed(0)}），疑似死循环，建议人工介入。`,
    );
    sent++;
    break; // 最多 1 个
  }
  // 冷却外的其余会话也标记为已通知（不清历史账）
  for (const a of sorted) {
    const key = `${a.agent}:${a.sessionId}`;
    if (!state.sessions[key]) state.sessions[key] = now;
  }
  save(state);
  return sent;
}
