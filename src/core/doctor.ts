// doctor — 环境与配置自检
//
// 为什么需要：token-pilot 的数据来自十几个不同的日志路径，任何一个读不到，
// 用户看到的账单就是不完整的。而这类问题**没有任何东西会报错**——路径不存在
// 只是静默少读，账单照常显示，只是数字偏小。用户不会怀疑「我的工具没工作」，
// 只会觉得「这个月花得少」。
//
// 所以 doctor 的核心职责是：把「你以为在读但实际没读到」的地方摊开来说清楚。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { CONFIG_DIR, CONFIG_PATH, DATA_PATH, loadConfig } from './config.js';
import { loadPricing } from './pricing.js';
import { ALL_ADAPTERS } from './collector.js';
import path from 'node:path';
import os from 'node:os';

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info';

export interface CheckItem {
  level: CheckLevel;
  title: string;
  detail: string;
  /** 可执行的修复建议，没有就不给 */
  fix?: string;
}

export interface DoctorReport {
  items: CheckItem[];
  ok: number;
  warn: number;
  error: number;
  /** 本次自检产生的建议条数（按严重度排序后取前 N 条作为结论） */
  advice: string[];
}

const marker = (lv: CheckLevel) => (lv === 'ok' ? '✅' : lv === 'warn' ? '⚠️ ' : lv === 'error' ? '❌' : 'ℹ️ ');

/** 把 ~ 展开成实际路径 */
function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** 数据文件距今多久（分钟） */
function dataAgeMinutes(): number | null {
  try {
    const st = statSync(DATA_PATH);
    return Math.floor((Date.now() - st.mtimeMs) / 60000);
  } catch {
    return null;
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const items: CheckItem[] = [];
  const push = (i: CheckItem) => items.push(i);

  // ── 1. 数据目录 ──
  if (existsSync(CONFIG_DIR)) {
    push({ level: 'ok', title: '数据目录', detail: CONFIG_DIR });
  } else {
    push({
      level: 'warn',
      title: '数据目录',
      detail: `${CONFIG_DIR} 还不存在（首次运行后自动创建）`,
      fix: '跑一次 `token-pilot sync` 就会建好',
    });
  }

  // ── 2. 采集宿主：逐个检测，重点说清「装了但读不到」 ──
  const detected: string[] = [];
  const missing: string[] = [];
  for (const ad of ALL_ADAPTERS) {
    let yes = false;
    try {
      yes = await ad.detect();
    } catch {
      yes = false;
    }
    if (yes) detected.push(ad.meta.displayName);
    else missing.push(ad.meta.displayName);
  }
  if (detected.length > 0) {
    push({
      level: 'ok',
      title: `可读宿主 ${detected.length} 个`,
      detail: detected.join('、'),
    });
  } else {
    push({
      level: 'error',
      title: '没有检测到任何可读宿主',
      detail: '所有 adapter 的检测路径都不存在，账单会是空的',
      fix: '确认你用的 AI 工具确实写本地日志；token-pilot 只读 ~/.claude、~/.codex 等目录',
    });
  }
  if (missing.length > 0) {
    push({
      level: 'info',
      title: `未检测到 ${missing.length} 个宿主`,
      detail: missing.join('、'),
    });
  }

  // ── 3. 数据新鲜度：过期的账单会误导预算判断 ──
  const age = dataAgeMinutes();
  if (age === null) {
    push({
      level: 'warn',
      title: '看板数据尚未生成',
      detail: DATA_PATH,
      fix: '跑 `token-pilot sync` 或 `token-pilot dash`',
    });
  } else if (age > 60 * 24) {
    push({
      level: 'warn',
      title: '看板数据超过一天没更新',
      detail: `最后一次生成在 ${Math.floor(age / 60)} 小时前`,
      fix: '桌面端会自动刷新；命令行用户请在 cron 里跑 `token-pilot sync`',
    });
  } else {
    push({ level: 'ok', title: '看板数据新鲜', detail: `${age} 分钟前更新` });
  }

  // ── 4. 定价覆盖度：这是账单准确性的根基 ──
  try {
    const pricing = loadPricing();
    const names = Object.keys(pricing.models ?? {});
    const overrideCount = Object.keys(loadConfig().priceOverrides ?? {}).length;
    push({
      level: names.length >= 10 ? 'ok' : 'warn',
      title: `定价表覆盖 ${names.length} 个模型`,
      detail:
        overrideCount > 0
          ? `其中 ${overrideCount} 个被人工覆写（覆写优先于目录价）`
          : '全部使用内置目录价',
      fix:
        names.length < 10
          ? '定价表偏小，未知模型会按 fallback 价估算，金额可能偏差'
          : undefined,
    });
  } catch (e) {
    push({
      level: 'error',
      title: '定价表读取失败',
      detail: String(e).slice(0, 120),
      fix: '`pricing/models.json` 可能损坏，重新安装或从仓库恢复',
    });
  }

  // ── 5. 预算配置 ──
  const cfg = loadConfig();
  if (cfg.monthlyBudgetCny && cfg.monthlyBudgetCny > 0) {
    push({
      level: 'ok',
      title: '已设置月度预算',
      detail: `¥${cfg.monthlyBudgetCny} · 超支达阈值会提醒`,
    });
  } else {
    push({
      level: 'info',
      title: '未设置月度预算',
      detail: '设置后托盘会常驻显示「¥今日 · 预算%」，超支时主动提醒',
      fix: '看板 → 数据设置 → 月度预算',
    });
  }

  // ── 6. 配置文件本身是否合法 ──
  if (existsSync(CONFIG_PATH)) {
    try {
      JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      push({ level: 'ok', title: '配置文件格式正确', detail: CONFIG_PATH });
    } catch {
      push({
        level: 'error',
        title: '配置文件不是合法 JSON',
        detail: CONFIG_PATH,
        fix: '备份后删除它，token-pilot 会重建默认配置',
      });
    }
  }

  // ── 7. RTK：装了没 / 是哪个来源 ──
  try {
    const { rtkStatus } = await import('./rtk.js');
    const st = await rtkStatus();
    if (st.source === 'ours') {
      push({ level: 'ok', title: 'RTK 输出压缩层', detail: st.detail });
    } else if (st.source === 'foreign') {
      push({
        level: 'info',
        title: 'RTK 来源提示',
        detail: st.detail,
        fix: '要看板代装 rtk-oss，需先卸载现有的 rtk',
      });
    } else {
      push({
        level: 'info',
        title: '未安装 RTK 输出压缩层',
        detail: '装上后命令输出会先压缩再进上下文，明显降低 token 消耗',
        fix: '看板 → 数据设置 → 勾选 RTK（也可手动 `brew install rtk`）',
      });
    }
  } catch {
    /* RTK 检测失败不影响整体自检 */
  }

  // ── 汇总 ──
  const ok = items.filter((i) => i.level === 'ok').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const error = items.filter((i) => i.level === 'error').length;

  // 建议只取 error/warn，且每条带 fix
  const advice = items
    .filter((i) => (i.level === 'error' || i.level === 'warn') && i.fix)
    .sort((a, b) => (a.level === 'error' ? -1 : 1) - (b.level === 'error' ? -1 : 1))
    .map((i) => i.fix as string);

  return { items, ok, warn, error, advice };
}

export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('token-pilot · 环境自检');
  lines.push('');

  for (const i of r.items) {
    lines.push(`  ${marker(i.level)} ${i.title}`);
    lines.push(`      ${i.detail}`);
    if (i.fix) lines.push(`      → ${i.fix}`);
  }

  lines.push('');
  lines.push(`  合计：${r.ok} 项正常 · ${r.warn} 项建议处理 · ${r.error} 项有问题`);

  if (r.advice.length > 0) {
    lines.push('');
    lines.push('  接下来可以做：');
    for (const a of r.advice.slice(0, 5)) lines.push(`    · ${a}`);
  } else {
    lines.push('');
    lines.push('  一切就绪，没有需要处理的项。');
  }
  lines.push('');
  return lines.join('\n');
}
