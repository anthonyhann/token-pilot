// Adapter 接口 — 声明式，学 LoongSuite Pilot 的 agents.d 思路
// 加一个新宿主 = 加一个 adapter 文件，不改核心

import type { UsageEvent } from '../core/schema.ts';

export interface AdapterMeta {
  id: string;                  // 'claude-code'
  displayName: string;         // 'Claude Code'
  // 检测：本机是否装了这个宿主
  detectPaths: string[];       // ['~/.claude']
  detectCommands?: string[];   // ['claude']
}

export interface Adapter {
  meta: AdapterMeta;

  // 本机是否装了
  detect(): Promise<boolean>;

  // 读取指定日期范围（含当天到现在的所有事件）
  // sinceMs: 起始时间戳（unix ms），不传 = 全部
  readEvents(sinceMs?: number): Promise<UsageEvent[]>;

  // 文件级能力（磁盘增量缓存用，可选）：
  listFiles?(): Promise<string[]>;                                       // 全部日志文件路径
  readFileEvents?(file: string, sinceMs?: number): Promise<UsageEvent[]>; // 解析单文件

  // 仅会话数能力（Qoder 这类无 token 数据的宿主用，可选）
  sessionCount?(): Promise<number>;
}

// 注册表
export const adapters: Adapter[] = [];
export function registerAdapter(a: Adapter) {
  adapters.push(a);
}
