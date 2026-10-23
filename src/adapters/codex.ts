// Codex adapter — 只读解析 ~/.codex/sessions/**/*.jsonl
// 格式：rollout jsonl，token 在 type=token_usage_record 事件的 payload.usage

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.js';
import type { Adapter } from './types.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    session_id?: string;
    usage?: CodexUsage;
    // model 在别的 event 里，rollout 里用 model_context_window / 或另查
  };
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
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function parseLine(line: string, file: string, lineNo: number): UsageEvent | null {
  if (!line.includes('"token_usage_record"')) return null;
  let d: CodexLine;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d.type !== 'token_usage_record') return null;
  const u = d.payload?.usage;
  if (!u) return null;

  // OpenAI 语义实测：input_tokens 包含 cached_input_tokens（cached 是子集），
  // total_tokens = input_tokens + output_tokens。
  // 新输入 = input − cached，缓存部分走 cacheRead 单价，不重复计费。
  const inputRaw = u.input_tokens ?? 0;
  const cacheRead = u.cached_input_tokens ?? 0;
  const cacheCreation = u.cache_write_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const input = Math.max(inputRaw - cacheRead, 0);

  return {
    agent: 'codex',
    sessionId: d.payload?.session_id ?? path.basename(file, '.jsonl'),
    eventId: `${path.basename(file, '.jsonl')}#${lineNo}`,
    timestamp: d.timestamp ? new Date(d.timestamp).getTime() : 0,
    provider: 'openai',
    model: 'codex', // rollout 里 model 名不稳定，先标 codex
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: input + output + cacheRead + cacheCreation,
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

export const codexAdapter: Adapter = {
  meta: {
    id: 'codex',
    displayName: 'Codex',
    detectPaths: ['~/.codex'],
    detectCommands: ['codex'],
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
  readFileContentEvents: readCodexContentEvents,
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

// 内容流：response_item 的 function_call / function_call_output，只取尺寸
export async function readCodexContentEvents(file: string, sinceMs = 0): Promise<import('../core/schema.ts').ContentEvent[]> {
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); } catch { return []; }
  const events: import('../core/schema.ts').ContentEvent[] = [];
  const sessionId = path.basename(file, '.jsonl');
  for (const line of content.split('\n')) {
    if (!line.includes('function_call')) continue;
    let d: { timestamp?: string; payload?: { type?: string; name?: string; arguments?: string; output?: string } };
    try { d = JSON.parse(line); } catch { continue; }
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
    if (ts < sinceMs) continue;
    const p = d.payload;
    if (p?.type === 'function_call') {
      events.push({
        agent: 'codex', sessionId, timestamp: ts, kind: 'tool_use',
        tool: p.name, sizeBytes: (p.arguments ?? '').length,
      });
    } else if (p?.type === 'function_call_output') {
      events.push({
        agent: 'codex', sessionId, timestamp: ts, kind: 'tool_result',
        sizeBytes: (p.output ?? '').length,
      });
    }
  }
  return events;
}
