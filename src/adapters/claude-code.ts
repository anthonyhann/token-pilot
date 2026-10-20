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

function parseLine(line: string, file: string): UsageEvent | null {
  if (!line.includes('"usage"')) return null;
  let d: ClaudeLine;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = d.message?.usage;
  const model = d.message?.model;
  if (!usage || !model || model === '<synthetic>') return null;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  return {
    agent: 'claude-code',
    sessionId: d.sessionId ?? path.basename(file, '.jsonl'),
    eventId: `${path.basename(file, '.jsonl')}`,
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
    const events: UsageEvent[] = [];
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
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const ev = parseLine(line, file);
        if (ev && ev.timestamp >= sinceMs) events.push(ev);
      }
    }
    return events;
  },
};
