// 未知模型追踪 + 状态
// 采集到的模型在定价表与覆写里都找不到时，记进 ~/.token-pilot/unknown-models.json，
// 由 price-fetch 每天自动上网查价补全，人工随时可在设置弹窗核对修改。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const UNKNOWN_PATH = path.join(CONFIG_DIR, 'unknown-models.json');

export interface UnknownModel {
  model: string;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  agents: string[];
  // 自动补价状态
  autoPrice?: { input: number; output: number; cacheRead?: number };  // ¥/1M
  source?: string;        // 价格来源 URL
  fetchedAt?: number;
  needsReview?: boolean;  // 自动填充的都要人工核对
  failedAttempts?: number;
}

type State = Record<string, UnknownModel>;

export function loadUnknown(): State {
  if (!existsSync(UNKNOWN_PATH)) return {};
  try { return JSON.parse(readFileSync(UNKNOWN_PATH, 'utf8')); } catch { return {}; }
}

export function saveUnknown(s: State): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(UNKNOWN_PATH, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

export function trackUnknown(model: string, agent: string, now = Date.now()): void {
  const s = loadUnknown();
  const u = s[model] ?? { model, firstSeen: now, lastSeen: now, calls: 0, agents: [] };
  u.lastSeen = now;
  u.calls++;
  if (!u.agents.includes(agent)) u.agents.push(agent);
  s[model] = u;
  saveUnknown(s);
}

export function markPriced(model: string, price: { input: number; output: number; cacheRead?: number }, source: string): void {
  const s = loadUnknown();
  const u = s[model];
  if (!u) return;
  u.autoPrice = price;
  u.source = source;
  u.fetchedAt = Date.now();
  u.needsReview = true;
  saveUnknown(s);
}

export function markFailed(model: string): void {
  const s = loadUnknown();
  const u = s[model];
  if (!u) return;
  u.failedAttempts = (u.failedAttempts ?? 0) + 1;
  saveUnknown(s);
}
