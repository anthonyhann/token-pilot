// Codex adapter — 只读解析 ~/.codex/sessions/**/*.jsonl
// 格式：rollout jsonl，token 在 type=token_usage_record 事件的 payload.usage

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

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
  let entries: fs.Dirent[];
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

function parseLine(line: string, file: string): UsageEvent | null {
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

  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cached_input_tokens ?? 0;
  const cacheCreation = u.cache_write_input_tokens ?? 0;

  return {
    agent: 'codex',
    sessionId: d.payload?.session_id ?? path.basename(file, '.jsonl'),
    eventId: path.basename(file, '.jsonl'),
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
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const ev = parseLine(line, file);
        if (ev && ev.timestamp >= sinceMs) events.push(ev);
      }
    }
    return events;
  },
};
