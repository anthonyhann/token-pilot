// Kimi Code adapter — 只读解析 ~/.kimi-code/sessions/*/agents/main/wire.jsonl
// 格式：wire.jsonl，usage 字段是 {inputOther, output, inputCacheRead, inputCacheCreation}

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.js';
import type { Adapter } from './types.js';

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
  let entries: Dirent[];
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

async function readFileEvents(file: string, sinceMs = 0): Promise<UsageEvent[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ev = parseLine(line, file, i);
    if (ev && ev.timestamp >= sinceMs) events.push(ev);
  }
  return events;
}

async function listFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkJsonl(SESSIONS_DIR)) out.push(f);
  return out;
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
  listFiles,
  readFileEvents,
  readFileContentEvents: readKimiContentEvents,
  async readEvents(sinceMs = 0): Promise<UsageEvent[]> {
    const events: UsageEvent[] = [];
    for (const file of await listFiles()) {
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      events.push(...(await readFileEvents(file, sinceMs)));
    }
    return events;
  },
};

// 内容流：agent.message.appended 里的 toolCalls / role=tool 结果，只取尺寸
export async function readKimiContentEvents(file: string, sinceMs = 0): Promise<import('../core/schema.ts').ContentEvent[]> {
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); } catch { return []; }
  const events: import('../core/schema.ts').ContentEvent[] = [];
  const sessionId = path.basename(path.dirname(path.dirname(file)));
  for (const line of content.split('\n')) {
    if (!line.includes('agent.message.appended')) continue;
    let d: { time?: number; message?: { message?: { role?: string; content?: unknown; toolCalls?: { name?: string; arguments?: string }[] } } };
    try { d = JSON.parse(line); } catch { continue; }
    const ts = d.time ?? 0;
    if (ts < sinceMs) continue;
    const msg = d.message?.message;
    if (!msg) continue;
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        events.push({
          agent: 'kimi-code', sessionId, timestamp: ts, kind: 'tool_use',
          tool: tc.name, sizeBytes: (tc.arguments ?? '').length,
        });
      }
    }
    if (msg.role === 'tool' && msg.content) {
      events.push({
        agent: 'kimi-code', sessionId, timestamp: ts, kind: 'tool_result',
        sizeBytes: JSON.stringify(msg.content).length,
      });
    }
  }
  return events;
}
