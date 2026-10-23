// DeepSeek Harness adapter — 只读解析 ~/.dsh/sessions/**/session.v4.jsonl.zstd
// DSH 会话日志是 zstd 压缩的 JSONL；usage 在 data.usage（OpenAI 风格命名），
// model 在同一行的 message 内容里（正则提取），时间戳在顶层 time（ms）。
// 语义实测：inputTokens=新输入（不含缓存），cacheReadTokens=缓存读，totalTokens≈input+cacheRead。
// 零依赖原则：zstd 解压走系统 zstd CLI（macOS brew 常见），缺了就跳过并在检测里如实标注。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.js';
import type { Adapter } from './types.js';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.dsh', 'sessions');

let zstdOk: boolean | null = null;
async function hasZstd(): Promise<boolean> {
  if (zstdOk !== null) return zstdOk;
  try {
    await execFileP('zstd', ['--version'], { timeout: 3000 });
    zstdOk = true;
  } catch {
    zstdOk = false;
  }
  return zstdOk;
}

async function* walkSessions(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkSessions(full);
    else if (e.isFile() && e.name === 'session.v4.jsonl.zstd') yield full;
  }
}

interface DshLine {
  type?: string;
  seq?: number;
  time?: number;
  data?: {
    turn?: number;
    step?: number;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number };
  };
}

const MODEL_RE = /"model"\s*:\s*"([^"]+)"/;

function parseLine(line: string, file: string): UsageEvent | null {
  if (!line.includes('"usage"')) return null;
  let d: DshLine;
  try { d = JSON.parse(line); } catch { return null; }
  const u = d.data?.usage;
  if (!u || typeof u.inputTokens !== 'number') return null;
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  if (input + output + cacheRead === 0) return null;

  const m = MODEL_RE.exec(line);
  const sessionId = path.basename(path.dirname(file));
  return {
    agent: 'dsh',
    sessionId,
    // 一次 API 调用 = 一条 usage（turn+step 粒度，实测逐步独立非累计）
    eventId: `${sessionId}#t${d.data?.turn ?? 0}s${d.data?.step ?? 0}q${d.seq ?? 0}`,
    timestamp: d.time ?? 0,
    provider: providerFromModel(m?.[1] ?? ''),
    model: m?.[1] ?? 'unknown',
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
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('step')) return 'stepfun';
  if (m.includes('glm')) return 'glm';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gpt')) return 'openai';
  return 'unknown';
}

async function readFileEvents(file: string, sinceMs = 0): Promise<UsageEvent[]> {
  let content: string;
  try {
    const r = await execFileP('zstd', ['-dc', file], { timeout: 60_000, maxBuffer: 512 * 1024 * 1024 });
    content = r.stdout;
  } catch {
    return [];
  }
  const events: UsageEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const ev = parseLine(line, file);
    if (ev && ev.timestamp >= sinceMs) events.push(ev);
  }
  // 同 seq 的流式快照去重（取最大 totalTokens）
  const byId = new Map<string, UsageEvent>();
  for (const ev of events) {
    const prev = byId.get(ev.eventId);
    if (!prev || ev.usage.totalTokens > prev.usage.totalTokens) byId.set(ev.eventId, ev);
  }
  return [...byId.values()];
}

async function listFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkSessions(SESSIONS_DIR)) out.push(f);
  return out;
}

export const dshAdapter: Adapter = {
  meta: {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    detectPaths: ['~/.dsh'],
  },

  async detect() {
    try {
      await fs.access(SESSIONS_DIR);
      return await hasZstd();
    } catch {
      return false;
    }
  },

  listFiles,
  readFileEvents,

  async readEvents(sinceMs = 0): Promise<UsageEvent[]> {
    if (!(await hasZstd())) return [];
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
