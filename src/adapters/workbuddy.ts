// WorkBuddy / WorkBuddy AI adapter — 只读解析 ~/.workbuddy{,-ai}/traces/*/**\/*.jsonl
// 结构：OTel 风格 trace 文件；trace_end.summary.modelInfo 有完整用量：
//   { models, totalInputTokens, totalOutputTokens, totalCachedTokens, callCount }
// 口径：trace 级聚合（一个 trace = 一次 Agent 工作流），逐调用粒度不可得——如实标注。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

const HOME = os.homedir();
const ROOTS: [string, string][] = [
  [path.join(HOME, '.workbuddy', 'traces'), 'workbuddy'],
  [path.join(HOME, '.workbuddy-ai', 'traces'), 'workbuddy-ai'],
];

interface WbSummary {
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  modelInfo?: {
    models?: string[];
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCachedTokens?: number;
    callCount?: number;
  };
}

interface WbLine {
  type?: string;
  summary?: WbSummary;
}

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function parseTraceEnd(line: string, file: string, agent: string): UsageEvent | null {
  if (!line.includes('"trace_end"') || !line.includes('modelInfo')) return null;
  let d: WbLine;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type !== 'trace_end') return null;
  const s = d.summary;
  const mi = s?.modelInfo;
  if (!s || !mi || !mi.models?.length) return null;

  const totalIn = mi.totalInputTokens ?? 0;
  const cacheRead = mi.totalCachedTokens ?? 0;
  const input = Math.max(totalIn - cacheRead, 0);
  const output = mi.totalOutputTokens ?? 0;
  if (input + cacheRead + output === 0) return null;

  const model = mi.models[0];
  return {
    agent,
    sessionId: s.sessionId ?? path.basename(file, '.jsonl'),
    eventId: path.basename(file, '.jsonl'),
    timestamp: s.endedAt ? new Date(s.endedAt).getTime() : 0,
    provider: providerFromModel(model),
    model,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: 0,
      totalTokens: input + output + cacheRead,
    },
  };
}

function providerFromModel(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('hy') || m.includes('hunyuan')) return 'hunyuan';
  if (m.includes('glm')) return 'glm';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gpt')) return 'openai';
  return 'unknown';
}

async function readFileEvents(file: string, sinceMs: number, agent: string): Promise<UsageEvent[]> {
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); } catch { return []; }
  const events: UsageEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const ev = parseTraceEnd(line, file, agent);
    if (ev && ev.timestamp >= sinceMs) events.push(ev);
  }
  return events;
}

function makeAdapter(root: string, agentId: string, displayName: string): Adapter {
  return {
    meta: { id: agentId, displayName, detectPaths: [path.dirname(root)] },
    async detect() {
      try { await fs.access(root); return true; } catch { return false; }
    },
    async listFiles() {
      const out: string[] = [];
      for await (const f of walkJsonl(root)) out.push(f);
      return out;
    },
    async readFileEvents(file: string, sinceMs = 0) {
      return readFileEvents(file, sinceMs, agentId);
    },
    async readEvents(sinceMs = 0) {
      return readFileEventsList(await this.listFiles!(), sinceMs, agentId);
    },
  };
}

async function readFileEventsList(files: string[], sinceMs: number, agent: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for (const file of files) {
    try {
      const st = await fs.stat(file);
      if (st.mtimeMs < sinceMs) continue;
    } catch { continue; }
    events.push(...(await readFileEvents(file, sinceMs, agent)));
  }
  return events;
}

export const workbuddyAdapter = makeAdapter(ROOTS[0][0], 'workbuddy', 'WorkBuddy');
export const workbuddyAiAdapter = makeAdapter(ROOTS[1][0], 'workbuddy-ai', 'WorkBuddy AI');
