// 数据源注册表 — 25 个源、6 档，驱动「适配器状态」模块与宿主用量榜的分档标签
// 状态语义：on=有数据接入 · part=部分支持/验证中 · off=未配置 · sub=仅检测/订阅登记

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AdapterChip, AdapterTier } from './contract.ts';
import type { TokenPilotConfig } from './config.ts';

const HOME = os.homedir();

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function countMatching(dir: string, match: (name: string, isDir: boolean) => boolean, depth = 6): Promise<number> {
  let n = 0;
  async function walk(d: string, lv: number) {
    if (lv > depth) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (match(e.name, e.isDirectory())) n++;
      if (e.isDirectory()) await walk(path.join(d, e.name), lv + 1);
    }
  }
  await walk(dir, 0);
  return n;
}

export interface HostTierInfo { label: string; cls: 'tier-1' | 'tier-2' | 'tier-0' }

// 宿主用量榜的分档标签
export const HOST_TIERS: Record<string, HostTierInfo> = {
  'claude-code': { label: '一档', cls: 'tier-1' },
  'kimi-code': { label: '一档', cls: 'tier-1' },
  'codex': { label: '一档', cls: 'tier-1' },
  'pi': { label: '一档', cls: 'tier-1' },
  'opencode': { label: '二档', cls: 'tier-2' },
  'qoder': { label: '无 token', cls: 'tier-0' },
};

export async function buildAdapterTiers(cfg: TokenPilotConfig): Promise<AdapterTier[]> {
  // ---- 一档：本地日志直读 ----
  const claudeDir = path.join(HOME, '.claude', 'projects');
  const kimiDir = path.join(HOME, '.kimi-code', 'sessions');
  const codexDir = path.join(HOME, '.codex', 'sessions');
  const piDir = path.join(HOME, '.pi');

  const [hasClaude, hasKimi, hasCodex, hasPi] = await Promise.all([
    exists(claudeDir), exists(kimiDir), exists(codexDir), exists(piDir),
  ]);

  const tier1: AdapterChip[] = [];
  if (hasClaude) {
    const n = await countMatching(claudeDir, (name, isDir) => !isDir && name.endsWith('.jsonl'));
    tier1.push({ name: 'Claude Code', status: 'on', hint: `${n.toLocaleString()} 个日志` });
  }
  if (hasKimi) {
    const n = await countMatching(kimiDir, (name, isDir) => isDir && name.startsWith('session_'), 2);
    tier1.push({ name: 'Kimi Code', status: 'on', hint: `${n} 个会话` });
  }
  if (hasCodex) {
    const n = await countMatching(codexDir, (name, isDir) => !isDir && name.endsWith('.jsonl'));
    tier1.push({ name: 'Codex', status: 'on', hint: `${n} 个 rollout` });
  }
  if (hasPi) {
    const n = await countMatching(piDir, (name, isDir) => !isDir && name.endsWith('.jsonl'));
    tier1.push({ name: 'pi', status: 'on', hint: `${n} 个会话` });
  }

  // ---- 二档：SQLite 直读 ----
  const opencodeDb = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
  const cursorDir = path.join(HOME, '.cursor');
  const tier2: AdapterChip[] = [];
  if (await exists(opencodeDb)) tier2.push({ name: 'OpenCode', status: 'on', hint: 'opencode.db 直读' });
  if (await exists(cursorDir)) tier2.push({ name: 'Cursor', status: 'sub', hint: '无 token 用量数据' });

  // ---- 特殊：仅会话数 ----
  const qoderDir = path.join(HOME, '.qoder');
  const special: AdapterChip[] = [];
  if (await exists(qoderDir)) {
    const n = await countMatching(qoderDir, (name, isDir) => isDir && /sess/i.test(name), 5);
    special.push({ name: 'Qoder', status: 'sub', hint: `${n} 个会话 · 无 token/模型` });
  }

  // ---- 四档：云端用量 API ----
  const hasDoubao = (cfg.cloudApis ?? []).some((a) => /doubao|豆包|火山/i.test(a.name)) || await exists(path.join(HOME, '.arkcli'));
  const tier4: AdapterChip[] = [
    { name: 'Doubao · 火山', status: hasDoubao ? 'on' : 'off', hint: hasDoubao ? 'arkcli 日粒度' : '未配置' },
    { name: 'OpenAI API', status: 'off', hint: '未配置' },
    { name: 'Kimi 开放平台', status: 'off', hint: '未配置' },
  ];

  // ---- 五档：仅检测（不写本地用量日志） ----
  const detectOnly: [string, string][] = [
    ['Antigravity', '.antigravity'], ['Augment', '.augment'], ['CodeBuddy', '.codebuddy'],
    ['Copilot', '.copilot'], ['Kilo', '.kilo'], ['Qwen Code', '.qwen'],
    ['Trae', '.trae'], ['Windsurf', '.windsurf'], ['ZCode', '.zcode'],
    ['Hermes', '.hermes'], ['Cline', '.cline'], ['Kimi (agents)', '.kimi'],
  ];
  const tier5: AdapterChip[] = [];
  for (const [name, dir] of detectOnly) {
    if (await exists(path.join(HOME, dir))) tier5.push({ name, status: 'sub' });
  }

  // ---- 六档：订阅登记 ----
  const subs = cfg.subscriptions ?? [];
  const tier6: AdapterChip[] = subs.length > 0
    ? subs.map((s) => ({ name: s.name, status: 'sub' as const, hint: `订阅 ¥${s.monthlyCny}/月` }))
    : [
        { name: 'Kimi.app', status: 'sub', hint: '未登记' },
        { name: 'ChatGPT.app', status: 'sub', hint: '未登记' },
      ];

  const tiers: AdapterTier[] = [];
  if (tier1.length) tiers.push({ key: 'local', label: '一档 · 本地日志直读', count: `${tier1.length} · 全量 token + 模型`, chips: tier1 });
  if (tier2.length) tiers.push({ key: 'local', label: '二档 · SQLite 直读', count: `${tier2.length}`, chips: tier2 });
  if (special.length) tiers.push({ key: 'detect', label: '特殊 · 仅会话数', count: `${special.length} · 无 token / 模型`, chips: special });
  tiers.push({ key: 'cloud', label: '四档 · 云端用量 API', count: `${tier4.length}`, chips: tier4 });
  if (tier5.length) tiers.push({ key: 'detect', label: '五档 · 仅检测', count: `${tier5.length} · 不写本地用量日志`, chips: tier5 });
  tiers.push({ key: 'sub', label: '六档 · 订阅登记', count: `${tier6.length} · 桌面端为瘦客户端`, chips: tier6 });
  return tiers;
}
