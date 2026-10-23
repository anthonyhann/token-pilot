// Doubao · 火山 adapter — 云端用量 API（经 arkcli usage stats，日粒度）
// 与本地日志粒度不同：云端是「每天×模型」的合计，一个 record 是一天总量（非单次调用）。
// 事件时间戳取当天中午；调用次数字段无法精确（记录的是 ReqCnt 汇总），会话维度不适用。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UsageEvent } from '../core/schema.js';
import type { Adapter } from './types.js';

const execFileP = promisify(execFile);

interface ArkRecord {
  Day?: string;
  Model?: string;
  ModelID?: string;
  Endpoint?: string;
  InputTokens?: number;
  CacheTokensHit?: number;
  OutputTokens?: number;
  TotalTokens?: number;
  ReqCnt?: number;
}

// arkcli 输出尾部可能跟非 JSON 行（升级提示等），只解析第一个完整 JSON 对象
function extractJson(raw: string): { records?: ArkRecord[] } | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const volcArkAdapter: Adapter = {
  meta: {
    id: 'volc-ark',
    displayName: 'Doubao · 火山',
    detectPaths: [],
    detectCommands: ['arkcli'],
  },

  async detect() {
    try {
      await execFileP('arkcli', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },

  async readEvents(sinceMs = 0): Promise<UsageEvent[]> {
    const start = ymd(new Date(sinceMs > 0 ? sinceMs : Date.now() - 40 * 86400_000));
    let out: string;
    try {
      const r = await execFileP('arkcli', ['usage', 'stats', '--start', start, '--format', 'json'], { timeout: 30_000 });
      out = r.stdout;
    } catch {
      return [];
    }
    const parsed = extractJson(out);
    if (!parsed?.records) return [];

    const events: UsageEvent[] = [];
    for (const rec of parsed.records) {
      const input = Math.max((rec.InputTokens ?? 0) - (rec.CacheTokensHit ?? 0), 0);
      const cacheRead = rec.CacheTokensHit ?? 0;
      const output = rec.OutputTokens ?? 0;
      if (input + cacheRead + output === 0) continue;
      const model = rec.Model ?? rec.ModelID ?? rec.Endpoint ?? 'doubao-cloud';
      // 日粒度：时间戳定当天中午
      const ts = rec.Day ? new Date(rec.Day + 'T12:00:00').getTime() : Date.now();
      if (ts < sinceMs) continue;
      events.push({
        agent: 'volc-ark',
        sessionId: `cloud-${rec.Day}`,
        eventId: `volc-${rec.Day}-${model}`,
        timestamp: ts,
        provider: 'doubao',
        model,
        usage: {
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: 0,
          totalTokens: input + output + cacheRead,
        },
      });
    }
    return events;
  },
};
