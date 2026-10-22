// Qoder adapter — 仅会话数（Qoder 不写 token/模型数据，model 全为 auto，实测确认）
// 只提供 sessionCount 能力供状态区展示，不产生计费事件（避免污染调用数/成本口径）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

const HOME = os.homedir();
const QODER_DIR = path.join(HOME, '.qoder');

async function countSessionDirs(dir: string, depth: number): Promise<number> {
  if (depth > 5) return 0;
  let n = 0;
  let entries: fs.Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/^sess|^session/i.test(e.name)) n++;
    n += await countSessionDirs(path.join(dir, e.name), depth + 1);
  }
  return n;
}

export const qoderAdapter: Adapter = {
  meta: {
    id: 'qoder',
    displayName: 'Qoder',
    detectPaths: ['~/.qoder'],
    detectCommands: ['qoder'],
  },
  async detect() {
    try { await fs.access(QODER_DIR); return true; } catch { return false; }
  },
  // Qoder 无 token 数据：只报会话数
  async sessionCount() {
    return countSessionDirs(QODER_DIR, 0);
  },
  async readEvents(): Promise<UsageEvent[]> {
    return []; // 故意为空：无 token 数据可采
  },
};
