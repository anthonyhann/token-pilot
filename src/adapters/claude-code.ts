// Claude Code adapter — 只读解析 ~/.claude/projects/**/*.jsonl
// 参考 ccusage 路线：不注入 hook，不改配置，纯只读

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { UsageEvent } from '../core/schema.ts';
import type { Adapter } from './types.ts';

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeLine {
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: ClaudeUsage;
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
    if (e.isDirectory()) {
      yield* walkJsonl(full);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

function parseLine(line: string, file: string, lineNo: number): UsageEvent | null {
  if (!line.includes('"usage"')) return null;
  let d: ClaudeLine;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = d.message?.usage;
  const model = d.message?.model;
  if (!usage || !model || model === '<synthetic>' || model === 'error') return null;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  // eventId 用 message.id 做去重键；缺 id 时退化为 文件+行号（不参与去重）
  const msgId = d.message?.id;
  const eventId = msgId ?? `${path.basename(file, '.jsonl')}#${lineNo}`;

  return {
    agent: 'claude-code',
    sessionId: d.sessionId ?? path.basename(file, '.jsonl'),
    eventId,
    timestamp: d.timestamp ? new Date(d.timestamp).getTime() : 0,
    provider: providerFromModel(model),
    model,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: input + output + cacheRead + cacheCreation,
    },
    workspace: d.cwd,
  };
}

// 从 model 名推 provider（国产模型识别在这）
function providerFromModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('glm')) return 'glm';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('doubao') || m.includes('seed')) return 'doubao';
  if (m.includes('minimax')) return 'minimax';
  if (m.includes('hunyuan') || m.includes('hy')) return 'hunyuan';
  if (m.includes('mimo')) return 'mimo';
  if (m.includes('longcat')) return 'longcat';
  if (m.includes('gpt')) return 'openai';
  return 'unknown';
}

// 抓会话标题：首条用户文本消息，截 40 字符
function grabTitle(line: string, out: Map<string, string>): void {
  try {
    const d = JSON.parse(line);
    if (d?.type !== 'user' || !d?.sessionId) return;
    if (out.has(d.sessionId)) return;
    const c = d.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      const t = c.find((b: { type?: string; text?: string }) => b?.type === 'text' && typeof b.text === 'string');
      text = t?.text ?? '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    // 跳过系统注入块：xml 标签、[SYSTEM]/[MESSAGE FROM...] 等方括号标签
    if (!text || text.startsWith('<') || text.startsWith('[')) return;
    out.set(d.sessionId, text.slice(0, 40));
  } catch {
    // 非 JSON 行忽略
  }
}

export const claudeCodeAdapter: Adapter = {
  meta: {
    id: 'claude-code',
    displayName: 'Claude Code',
    detectPaths: ['~/.claude'],
    detectCommands: ['claude'],
  },

  async detect() {
    try {
      await fs.access(PROJECTS_DIR);
      return true;
    } catch {
      return false;
    }
  },

  async readEvents(sinceMs = 0): Promise<UsageEvent[]> {
    // 同一 message.id 会写出多行流式快照（前几行 usage 全零，末行才是真实值）。
    // 去重策略：按 eventId 分组，保留 totalTokens 最大的一条（ccusage 语义）。
    const byId = new Map<string, UsageEvent>();
    const titleBySession = new Map<string, string>();
    for await (const file of walkJsonl(PROJECTS_DIR)) {
      // 文件 mtime 早于 since 就整个跳过（快计算）
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
        // 顺手抓会话标题（首条用户文本消息），成本只是一次子串判断
        if (line.includes('"type":"user"') && line.includes('"content"')) {
          grabTitle(line, titleBySession);
        }
        const ev = parseLine(line, file, i);
        if (!ev || ev.timestamp < sinceMs) continue;
        const prev = byId.get(ev.eventId);
        if (!prev || ev.usage.totalTokens > prev.usage.totalTokens) {
          byId.set(ev.eventId, ev);
        }
      }
    }
    const events = [...byId.values()];
    for (const ev of events) {
      const t = titleBySession.get(ev.sessionId);
      if (t) ev.sessionTitle = t;
    }
    return events;
  },
};
