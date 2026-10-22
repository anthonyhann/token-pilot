// pi adapter — 只读解析 ~/.pi/agent/sessions/**/*.jsonl
// 结构：type=message 且 message.role=assistant 且 message.usage {input,output,cacheRead,cacheWrite}
// 全零 usage（coding-plan 代理常报 0）过滤掉，不计费不误导。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.pi', 'agent', 'sessions');

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function parseLine(line: string, file: string, lineNo: number): UsageEvent | null {
  if (!line.includes('"usage"')) return null;
  let d: {
    type?: string; id?: string; timestamp?: string;
    message?: { role?: string; model?: string; provider?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
  };
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type !== 'message' || d.message?.role !== 'assistant' || !d.message.usage) return null;
  const u = d.message.usage;
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const cacheCreation = u.cacheWrite ?? 0;
  if (input + output + cacheRead + cacheCreation === 0) return null; // 全零不计

  return {
    agent: 'pi',
    sessionId: path.basename(file, '.jsonl'),
    eventId: `${path.basename(file, '.jsonl')}#${d.id ?? lineNo}`,
    timestamp: d.timestamp ? new Date(d.timestamp).getTime() : 0,
    provider: d.message.provider ?? 'unknown',
    model: d.message.model ?? 'unknown',
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
  try { content = await fs.readFile(file, 'utf8'); } catch { return []; }
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

export const piAdapter: Adapter = {
  meta: {
    id: 'pi',
    displayName: 'pi',
    detectPaths: ['~/.pi'],
    detectCommands: ['pi'],
  },
  async detect() {
    try { await fs.access(SESSIONS_DIR); return true; } catch { return false; }
  },
  listFiles,
  readFileEvents,
  async readEvents(sinceMs = 0) {
    const events: UsageEvent[] = [];
    for (const file of await listFiles()) {
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs < sinceMs) continue;
      } catch { continue; }
      events.push(...(await readFileEvents(file, sinceMs)));
    }
    return events;
  },
};
