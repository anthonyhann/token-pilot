// OpenCode adapter — 只读解析 ~/.local/share/opencode/opencode.db（SQLite）
// 结构：message 表 data JSON 内含 role/tokens{input,output,cache{read,write}}/modelID/providerID/path.cwd
// 只取 role=assistant 且有 tokens 的行（计费等价物）。零依赖：node:sqlite 内置。

import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

const HOME = os.homedir();
const DB_PATH = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

interface OcMsg {
  role?: string;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  modelID?: string;
  providerID?: string;
  path?: { cwd?: string };
}

function toEvent(id: string, sessionId: string, timeCreated: number, data: string): UsageEvent | null {
  let d: OcMsg;
  try { d = JSON.parse(data); } catch { return null; }
  if (d.role !== 'assistant' || !d.tokens) return null;
  const t = d.tokens;
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const cacheRead = t.cache?.read ?? 0;
  const cacheCreation = t.cache?.write ?? 0;
  if (input + output + cacheRead + cacheCreation === 0) return null;
  return {
    agent: 'opencode',
    sessionId,
    eventId: id,
    timestamp: timeCreated,
    provider: d.providerID ?? 'unknown',
    model: d.modelID ?? 'unknown',
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: input + output + cacheRead + cacheCreation,
    },
    workspace: d.path?.cwd,
  };
}

export const opencodeAdapter: Adapter = {
  meta: {
    id: 'opencode',
    displayName: 'OpenCode',
    detectPaths: ['~/.local/share/opencode'],
    detectCommands: ['opencode'],
  },

  async detect() {
    try { await fs.access(DB_PATH); return true; } catch { return false; }
  },

  async listFiles() {
    return [DB_PATH];
  },

  async readFileEvents(file: string, sinceMs = 0): Promise<UsageEvent[]> {
    const events: UsageEvent[] = [];
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare(
        `SELECT id, session_id, time_created, data FROM message
         WHERE time_created >= ? AND json_extract(data,'$.tokens') IS NOT NULL
         AND json_extract(data,'$.role') = 'assistant'`
      ).all(sinceMs) as { id: string; session_id: string; time_created: number; data: string }[];
      for (const r of rows) {
        const ev = toEvent(r.id, r.session_id, r.time_created, r.data);
        if (ev) events.push(ev);
      }
    } catch {
      // db 被锁或损坏时静默跳过（只读不该影响 OpenCode 本体）
    } finally {
      try { db?.close(); } catch { /* 忽略 */ }
    }
    return events;
  },

  async readEvents(sinceMs = 0) {
    return this.readFileEvents!(DB_PATH, sinceMs);
  },
};

// 内容流：part 表 type=tool 的 state.input/output，只取尺寸
export async function readOpencodeContentEvents(file: string, sinceMs = 0): Promise<import('../core/schema.ts').ContentEvent[]> {
  const events: import('../core/schema.ts').ContentEvent[] = [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(
      `SELECT p.session_id AS sid, p.time_created AS ts, p.data AS data
       FROM part p WHERE p.time_created >= ? AND json_extract(p.data,'$.type') = 'tool'`
    ).all(sinceMs) as { sid: string; ts: number; data: string }[];
    for (const r of rows) {
      let d: { tool?: string; state?: { input?: unknown; output?: unknown } };
      try { d = JSON.parse(r.data); } catch { continue; }
      const inSize = d.state?.input ? JSON.stringify(d.state.input).length : 0;
      const outSize = d.state?.output ? JSON.stringify(d.state.output).length : 0;
      events.push({ agent: 'opencode', sessionId: r.sid, timestamp: r.ts, kind: 'tool_use', tool: d.tool, sizeBytes: inSize });
      if (outSize > 0) {
        events.push({ agent: 'opencode', sessionId: r.sid, timestamp: r.ts, kind: 'tool_result', tool: d.tool, sizeBytes: outSize });
      }
    }
  } catch {
    // 锁定或损坏时跳过
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }
  return events;
}
