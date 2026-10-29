// 火山方舟额度：调 `arkcli usage plan --format json`
//
// 这是全部平台里唯一有权威额度 API 的，返回结构已经本机实测确认：
//
//   {
//     "viewer": { "profile": "coding-plan_...", ... },
//     "items": [{
//       "product": "coding-plan", "edition": "personal", "tier": "lite",
//       "subscribed": true,
//       "periods": [
//         { "label": "weekly", "percent": 11.28, "reset_at": "2026-11-02T00:00:00+08:00" }
//       ]
//     }]
//   }
//
// 重要差异（决定 UI 显示什么）：
//   - agent-plan：给 used/total 绝对值
//   - coding-plan：**只给 percent，没有 used/total** —— 不得编造绝对值

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderQuota, RateWindow } from '../types.js';

const execFileP = promisify(execFile);

/** period label → 中文名 + 窗口分钟数（窗口长度用于算节奏） */
const LABELS: Record<string, { label: string; minutes: number }> = {
  '5h': { label: '5 小时', minutes: 5 * 60 },
  session: { label: '会话窗口', minutes: 5 * 60 },
  weekly: { label: '本周', minutes: 7 * 24 * 60 },
  monthly: { label: '本月', minutes: 30 * 24 * 60 },
};

const PRODUCT_NAMES: Record<string, string> = {
  'agent-plan': 'Agent Plan',
  'coding-plan': 'Coding Plan',
  'agent-plan-team': 'Agent Plan（团队）',
  'coding-plan-team': 'Coding Plan（团队）',
};

interface ArkPeriod {
  label?: string;
  used?: number;
  total?: number;
  percent?: number;
  reset_at?: string;
}

interface ArkItem {
  product?: string;
  edition?: string;
  tier?: string;
  subscribed?: boolean;
  periods?: ArkPeriod[];
  updated_at?: number;
  error?: string;
}

interface ArkPlanResponse {
  viewer?: { profile?: string; region?: string };
  items?: ArkItem[];
}

/** 把 arkcli 的一个 item 转成一组窗口 */
function toWindows(item: ArkItem): RateWindow[] {
  const productName = PRODUCT_NAMES[item.product ?? ''] ?? item.product ?? '火山';
  const tier = item.tier ? ` ${item.tier}` : '';
  const out: RateWindow[] = [];

  for (const p of item.periods ?? []) {
    const meta = LABELS[p.label ?? ''];
    const label = meta?.label ?? p.label ?? '窗口';
    // Coding Plan 没有绝对值；Agent Plan 有
    const hasAbs = typeof p.used === 'number' || typeof p.total === 'number';
    out.push({
      id: `${item.product ?? 'volc'}-${p.label ?? 'w'}`,
      label: `${productName}${tier} · ${label}`,
      percent: typeof p.percent === 'number' ? p.percent : 0,
      used: hasAbs ? p.used : undefined,
      total: hasAbs ? p.total : undefined,
      resetsAt: p.reset_at,
      windowMinutes: meta?.minutes,
      unit: item.product?.startsWith('agent-plan') ? 'AFP' : 'requests',
    });
  }
  return out;
}

export async function fetchVolcQuota(): Promise<ProviderQuota> {
  const base: ProviderQuota = {
    id: 'volc',
    displayName: '火山方舟',
    source: 'cli',
    ok: false,
    fetchedAt: Date.now(),
  };

  let raw: string;
  try {
    const { stdout } = await execFileP(
      'arkcli',
      ['usage', 'plan', '--format', 'json'],
      { timeout: 30_000 },
    );
    raw = stdout;
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? e).slice(0, 200);
    // arkcli 未安装 / 未登录是常见情况，给出可执行提示
    const hint = /ENOENT/.test(msg)
      ? '未安装 arkcli（可选组件，装了才能读火山额度）'
      : /state_migration|login|auth/i.test(msg)
        ? 'arkcli 未就绪，请在终端跑一次 arkcli profile list 完成初始化'
        : msg;
    return { ...base, error: hint };
  }

  let parsed: ArkPlanResponse;
  try {
    parsed = JSON.parse(raw) as ArkPlanResponse;
  } catch {
    return { ...base, error: 'arkcli 输出了非 JSON 内容' };
  }

  const items = (parsed.items ?? []).filter((i) => i.subscribed);
  if (items.length === 0) {
    return { ...base, error: '当前账号没有查到已订阅的 Agent Plan / Coding Plan' };
  }

  const windows: RateWindow[] = [];
  const notes: string[] = [];
  for (const item of items) {
    windows.push(...toWindows(item));
    // 如实标注：Coding Plan 只有百分比
    if (item.product?.startsWith('coding-plan')) {
      const anyPercentOnly = (item.periods ?? []).every(
        (p) => p.used == null && p.total == null,
      );
      if (anyPercentOnly) notes.push('Coding Plan 仅提供已用百分比，平台不下发绝对值');
    }
    if (item.error) notes.push(`${item.product}: ${item.error}`);
  }

  return {
    ...base,
    ok: windows.length > 0,
    windows,
    note: notes.length > 0 ? notes.join('；') : undefined,
    error: windows.length === 0 ? '返回了订阅但没有任何额度窗口' : undefined,
  };
}
