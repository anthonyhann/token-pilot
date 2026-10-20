// Kimi Code adapter — 只读解析 ~/.kimi-code/sessions/*/agents/main/wire.jsonl
// 格式：wire.jsonl，usage 字段是 {inputOther, output, inputCacheRead, inputCacheCreation}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.kimi-code', 'sessions');

interface KimiUsage {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}

interface KimiLine {
  type?: string;
  model?: string;
  usage?: KimiUsage;
  time?: number; // unix ms
}

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name === 'wire.jsonl') yield full;
  }
}

function parseLine(line: string, file: string, lineNo: number): UsageEvent | null {
  if (!line.includes('"usage.record"')) return null;
  let d: KimiLine;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  // 只认 usage.record；其他类型（context.append_loop_event / agent.message.appended）带 usage 字样但不是计费记录
  if (d.type !== 'usage.record') return null;
  const u = d.usage;
  if (!u || !d.model) return null;

  const inputOther = u.inputOther ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.inputCacheRead ?? 0;
  const cacheCreation = u.inputCacheCreation ?? 0;
  // inputOther 是不走缓存的新输入；缓存部分交给 cacheRead/cacheCreation 单价，不能并入 input 重复计费

  return {
    agent: 'kimi-code',
    sessionId: path.basename(path.dirname(path.dirname(file))),
    eventId: `${path.basename(path.dirname(path.dirname(file)))}#${lineNo}`,
    timestamp: d.time ?? 0,
    provider: 'kimi',
    model: d.model,
    usage: {
      inputTokens: inputOther,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: inputOther + output + cacheRead + cacheCreation,
    },
  };
}

export const kimiCodeAdapter: Adapter = {
  meta: {
    id: 'kimi-code',
    displayName: 'Kimi Code',
    detectPaths: ['~/.kimi-code'],
    detectCommands: ['kimi'],
  },
  async detect() {
    try {
      await fs.access(SESSIONS_DIR);
      return true;
    } catch {
      return false;
    }
  },
  async readEvents(sinceMs = 0): Promise<UsageEvent[]> {
    const events: UsageEvent[] = [];
    for await (const file of walkJsonl(SESSIONS_DIR)) {
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const ev = parseLine(line, file, i);
        if (ev && ev.timestamp >= sinceMs) events.push(ev);
      }
    }
    return events;
  },
};
