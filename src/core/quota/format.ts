// 额度快照的终端渲染
//
// 参考 TodoBar / TokenBar 的做法：进度条 + 百分比 + 重置倒计时 + 节奏标记。
// 「节奏」那一列是这套数据的核心价值——单看 60% 没意义，
// 知道「窗口才过 40% 就已经用了 60%」才知道该不该踩刹车。

import type { ProviderQuota, QuotaSnapshot, RateWindow } from './types.js';
import { paceDelta, untilReset } from './types.js';

const BAR_WIDTH = 14;
/** 按终端显示宽度补空格（中文占 2 格） */
function padDisplay(str: string, width: number): string {
  let w = 0;
  for (const ch of str) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, width - w));
}


function bar(percent: number): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function paceMark(w: RateWindow): string {
  const d = paceDelta(w);
  if (d === null) return '';
  if (d > 15) return ` ⚠️ 比线性节奏快 ${Math.round(d)}%`;
  if (d < -15) return ` ✓ 比线性节奏慢 ${Math.round(-d)}%`;
  return '';
}

function windowLine(w: RateWindow, indent: string): string[] {
  const out: string[] = [];
  const pct = `${w.percent.toFixed(w.percent < 10 ? 1 : 0)}%`.padStart(5);
  // 有绝对值就显示，没有就只显示百分比（Coding Plan 就是这种）
  const abs =
    typeof w.used === 'number' && typeof w.total === 'number'
      ? `  ${w.used}/${w.total}`
      : '';
  const reset = untilReset(w);
  const resetStr = reset ? `  ${reset}刷新` : '';

  out.push(`  ${indent}${bar(w.percent)} ${pct}${abs}${resetStr}${paceMark(w)}`);
  return out;
}

export function formatQuota(snap: QuotaSnapshot): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('token-pilot · 订阅额度与余额');
  lines.push('');

  if (snap.cached) lines.push('  （缓存结果，5 分钟内不重复请求；--force 强制刷新）');
  if (snap.cached) lines.push('');

  if (snap.providers.length === 0) {
    lines.push('  还没有可监控的平台。');
    lines.push('  → 火山：安装 arkcli 并登录后自动出现');
    lines.push('');
    return lines.join('\n');
  }

  for (const p of snap.providers) {
    lines.push(`  ${p.displayName}  ${sourceTag(p)}`);
    if (!p.ok) {
      lines.push(`    ✗ ${p.error ?? '获取失败'}`);
      lines.push('');
      continue;
    }

    if (p.windows && p.windows.length > 0) {
      for (const w of p.windows) {
        const pct = `${w.percent.toFixed(w.percent < 10 ? 1 : 0)}%`.padStart(5);
        const abs =
          typeof w.used === 'number' && typeof w.total === 'number' ? `  ${w.used}/${w.total}` : '';
        const reset = untilReset(w);
        const resetStr = reset ? `  ${reset}刷新` : '';
        lines.push(`    ${padDisplay(w.label, 14)} ${bar(w.percent)} ${pct}${abs}${resetStr}${paceMark(w)}`);
      }
    }
    if (p.tokenPlan) {
      const t = p.tokenPlan;
      const name = t.planName ?? 'Token Plan';
      if (t.percent != null) {
        lines.push(`    ${padDisplay(name, 14)} ${bar(t.percent)} ${t.percent.toFixed(0).padStart(3)}%`);
      } else {
        lines.push(`    ${name}`);
      }
      if (t.remainingTokens != null) {
        lines.push(`      剩余 ${fmtTokens(t.remainingTokens)} tokens`);
      }
    }
    if (p.balance) {
      const sym = p.balance.currency === 'CNY' ? '¥' : '$';
      lines.push(`    余额        ${sym}${p.balance.amount.toFixed(2)}`);
    }
    if (p.note) lines.push(`    ℹ️  ${p.note}`);
    lines.push('');
  }

  return lines.join('\n');
}

function sourceTag(p: ProviderQuota): string {
  switch (p.source) {
    case 'api':
      return '（官方接口）';
    case 'cli':
      return '（官方 CLI）';
    case 'computed':
      return '（本地计算）';
    case 'manual':
      return '（手动登记）';
    default:
      return '';
  }
}

function fmtTokens(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(Math.round(n));
}
