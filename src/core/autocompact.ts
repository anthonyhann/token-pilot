// 自动压缩执行层
// 诚实边界：运行中的会话无法从外部压缩（那需要代理层）。
// 能做的是：① 经用户明示后写入 Claude Code 的 autoCompactEnabled（影响新会话）
//          ② 超阈值会话发系统通知提醒手动 /compact

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

export interface AutoCompactApplyResult {
  ok: boolean;
  message: string;
}

// 写入/关闭 Claude Code 的 autoCompactEnabled（用户明示后才调用）
export function applyClaudeAutoCompact(enabled: boolean): AutoCompactApplyResult {
  try {
    let cfg: Record<string, unknown> = {};
    if (existsSync(CLAUDE_SETTINGS)) {
      cfg = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
    }
    cfg.autoCompactEnabled = enabled;
    mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      message: enabled
        ? '已开启 Claude Code 自动压缩（对之后新开的会话生效；进行中的会话请手动 /compact）'
        : '已关闭 Claude Code 自动压缩',
    };
  } catch (e) {
    return { ok: false, message: `写入失败：${String(e)}` };
  }
}

export function readClaudeAutoCompact(): boolean | null {
  try {
    if (!existsSync(CLAUDE_SETTINGS)) return null;
    const cfg = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
    return typeof cfg.autoCompactEnabled === 'boolean' ? cfg.autoCompactEnabled : null;
  } catch {
    return null;
  }
}
