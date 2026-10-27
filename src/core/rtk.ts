// RTK（Rust Token Killer）接入层 — 用户显式勾选才安装；rtk-oss 纯 Apache 版
// 原则：少采集/不拦截——rtk 是独立的输出压缩工具，token-pilot 只负责装/检测/卸载，不嵌进请求链。
//
// 设计约束（都是踩过的坑）：
//   1. 「装好了吗」不能只看 `rtk --version` 能不能跑——用户可能早就装了另一个来源的 rtk。
//      必须区分「我们装的 rtk-oss」和「别人装的 rtk」。
//   2. 系统里已有 brew 主仓库的 rtk 时，rtk-oss 与之 conflicts_with（都占用 rtk 二进制），
//      brew 会直接失败。此时要明确告诉用户冲突原因，而不是回退到「brew install rtk」
//      然后因为已经装着而误报成功。
//   3. 失败必须把**真实原因**带回前端，不能吞成一句「仅本地预览生效」。

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** rtk 的安装来源 */
export type RtkSource = 'ours' | 'foreign' | 'none';

export interface RtkStatus {
  installed: boolean;
  /** 'ours' = 通过本工具安装的 rtk-oss；'foreign' = 别的来源（brew 主仓库 / 手动）；'none' = 未安装 */
  source: RtkSource;
  /** rtk --version 的原始输出，未安装为空 */
  version: string;
  /** 人话说明，直接给前端展示 */
  detail: string;
}

// 用的是带压缩引擎（engine）的 rtk 完整版（Apache-2.0 + BUSL-1.1），
// 不是 rtk-oss —— oss 版砍掉了 engine，压缩能力明显弱一档。
// 两者安装同名二进制，互斥。
const BREW_FORMULA_TARGET = 'rtk';
const BREW_FORMULA_OSS = 'rtk-oss';

async function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  try {
    const r = await execFileP(cmd, args, { timeout });
    return (r.stdout || '').trim();
  } catch {
    return null;
  }
}

/** 同 run，但失败时返回 stderr，用于把真实失败原因带回前端 */
async function runVerbose(
  cmd: string,
  args: string[],
  timeout = 5000,
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await execFileP(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, out: '', err: (err?.stderr || err?.message || String(e)).trim() };
  }
}

/** brew 里是否装了某个 formula（精确匹配，避免 rtk 与 rtk-oss 混淆） */
async function brewHas(formula: string): Promise<boolean> {
  const out = await run('brew', ['list', '--formula'], 20_000);
  if (!out) return false;
  return out.split('\n').map((s) => s.trim()).includes(formula);
}

/**
 * 判断 rtk 的安装来源：
 *   - brew 里有 rtk-oss           → ours
 *   - brew 里有 rtk（主仓库）      → foreign
 *   - 二进制存在但 brew 不认       → foreign（手动/其他包管理器）
 *   - 二进制不存在                 → none
 */
export async function rtkStatus(): Promise<RtkStatus> {
  if (process.platform === 'win32') {
    const ver = await run('rtk', ['--version']);
    if (!ver) return { installed: false, source: 'none', version: '', detail: '未安装' };
    const wl = await run('winget', ['list', '--id', 'rtk-ai.rtk', '-e', '--accept-source-agreements'], 30_000);
    const ours = !!wl && wl.includes('rtk-ai.rtk');
    return {
      installed: true,
      source: ours ? 'ours' : 'foreign',
      version: ver,
      detail: ours ? `已安装 ${ver}（含压缩引擎）` : `已安装 ${ver}（来源不是 rtk 完整版）`,
    };
  }

  const ver = await run('rtk', ['--version']);
  const hasOss = await brewHas('rtk-oss');
  const hasTarget = await brewHas(BREW_FORMULA_TARGET);

  if (!ver) {
    return { installed: false, source: 'none', version: '', detail: '未安装' };
  }
  if (hasTarget) {
    return { installed: true, source: 'ours', version: ver, detail: `已安装 ${ver}（含压缩引擎）` };
  }
  if (hasOss) {
    return {
      installed: true,
      source: 'foreign',
      version: ver,
      detail: `已安装 ${ver}（rtk-oss 纯 Apache 版，不含压缩引擎），需换成完整版`,
    };
  }
  return {
    installed: true,
    source: 'foreign',
    version: ver,
    detail: `已安装 ${ver}，但不是通过 Homebrew/本工具安装的`,
  };
}

/** 兼容旧调用点 */
export async function rtkInstalled(): Promise<boolean> {
  return (await rtkStatus()).installed;
}

export interface RtkInstallResult {
  ok: boolean;
  message: string;
}

/**
 * 安装 rtk-oss。核心改进：先做冲突预检，冲突时**明确报错**而不是回退后误报成功。
 */
export async function installRtk(): Promise<RtkInstallResult> {
  const before = await rtkStatus();

  if (before.installed && before.source === 'ours') {
    // 已装好二进制，但 hook 可能还没接上 —— 补一次 init
    const init = await ensureInit();
    return init.ok
      ? { ok: true, message: `RTK 已安装（${before.version}）` }
      : { ok: false, message: init.message };
  }

  // 已装 rtk-oss：与完整版互斥，必须先卸
  if (before.installed && before.source === 'foreign') {
    return {
      ok: false,
      message:
        `检测到系统里已安装 ${before.version}，但那是不含压缩引擎的 rtk-oss，与完整版 rtk 互斥（同名二进制）。` +
        (process.platform === 'win32'
          ? '请先卸载 rtk-oss 再勾选。'
          : `请先执行 \`brew uninstall ${BREW_FORMULA_OSS}\`，再重新勾选。`),
    };
  }

  try {
    if (process.platform === 'win32') {
      await execFileP(
        'winget',
        ['install', '--id', 'rtk-ai.rtk', '-e', '--accept-source-agreements', '--accept-package-agreements'],
        { timeout: 300_000 },
      );
    } else {
      await execFileP('brew', ['install', BREW_FORMULA_TARGET], { timeout: 300_000 });
    }
  } catch (e) {
    return { ok: false, message: `安装失败：${extractErr(e)}` };
  }

  const after = await rtkStatus();
  if (!after.installed) {
    return { ok: false, message: '安装命令执行了但 rtk 命令仍不可用，请手动检查' };
  }
  if (after.source !== 'ours') {
    return { ok: false, message: `安装命令执行完了，但检测到的 rtk 来源不对：${after.detail}` };
  }

  // 装好二进制后接 hook：rtk init -g 会写 ~/.claude/RTK.md 并 patch settings.json
  const init = await ensureInit();
  return init.ok
    ? { ok: true, message: `RTK 已安装并接入（${after.version}）` }
    : { ok: false, message: `RTK 已安装，但接入失败：${init.message}` };
}

/**
 * 确保 rtk 的 PreToolUse hook 已接入 Claude Code。
 *
 * 为什么需要备份：`rtk init -g` 会 patch ~/.claude/settings.json。用户可能在里面
 * 已经配了几十条别的 hook（本机实测 33 条），一旦 rtk 写坏，影响的是所有
 * Claude Code 会话。所以写入前先备份，失败则回滚。
 */
async function ensureInit(): Promise<RtkInstallResult> {
  const settings = claudeSettingsPath();
  const backup = `${settings}.bak-tokenpilot-${Date.now()}`;

  try {
    // 已有 RTK hook 就不重复装
    if (existsSync(settings)) {
      const cur = readFileSync(settings, 'utf8');
      if (cur.includes('rtk')) {
        const pre = await run('rtk', ['init', '-g', '--dry-run'], 30_000);
        if (pre && !/would patch|would update|would prompt/i.test(pre)) {
          return { ok: true, message: 'RTK hook 已接入' };
        }
      }
      // 备份（用户配置珍贵，出错能还原）
      try {
        copyFileSync(settings, backup);
      } catch {
        // 备份失败也继续——rtk 自己会提示确认；但不静默声称已备份
      }
    }

    // --auto-patch：不弹交互确认。Web/Tauri 后端没有 TTY，不加会卡住到超时。
    const res = await runVerbose('rtk', ['init', '-g', '--auto-patch'], 90_000);
    if (!res.ok) {
      restoreBackup(settings, backup);
      // 把 rtk 的真实报错带出去（常见：~/.claude 无写权限、settings.json 只读）
      const why = res.err.split('\n').filter((l) => l.trim()).slice(0, 2).join(' / ');
      return {
        ok: false,
        message: `rtk init -g 执行失败：${why || '未知原因'}（已还原配置）`,
      };
    }
    // 校验 settings.json 仍是合法 JSON，防止写坏
    if (existsSync(settings)) {
      try {
        JSON.parse(readFileSync(settings, 'utf8'));
      } catch {
        restoreBackup(settings, backup);
        return { ok: false, message: 'rtk init 写坏了 settings.json，已从备份还原' };
      }
    }
    // 退出码 0 不等于 hook 真的装上了——用 rtk 自己的状态命令复核
    const show = await run('rtk', ['init', '--show'], 20_000);
    if (show && /Hook:\s*not found/i.test(show)) {
      return {
        ok: false,
        message: 'rtk init 执行成功但 hook 仍未生效（~/.claude 可能无写权限），请检查后重试',
      };
    }
    return { ok: true, message: 'RTK hook 已接入 Claude Code' };
  } catch (e) {
    restoreBackup(settings, backup);
    return { ok: false, message: `接入失败：${extractErr(e)}（已尝试还原配置）` };
  }
}

function claudeSettingsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.claude', 'settings.json');
}

function restoreBackup(settings: string, backup: string): void {
  try {
    if (existsSync(backup)) copyFileSync(backup, settings);
  } catch {
    /* 还原失败只能放弃，错误已在上层报告 */
  }
}

export async function uninstallRtk(): Promise<RtkInstallResult> {
  const cur = await rtkStatus();
  if (!cur.installed) return { ok: true, message: 'RTK 未安装，无需卸载' };

  // 只卸载我们认定的完整版；rtk-oss 等外来版本不擅自删
  if (cur.source === 'foreign') {
    return { ok: false, message: `${cur.detail}——不是本工具安装的，为避免误删请手动卸载` };
  }

  // 先尝试让 rtk 自己撤掉 hook（它会清理 settings.json 里的条目）
  await run('rtk', ['init', '-g', '--uninstall'], 60_000);

  try {
    if (process.platform === 'win32') {
      await execFileP('winget', ['uninstall', '--id', 'rtk-ai.rtk', '-e'], { timeout: 180_000 });
    } else {
      await execFileP('brew', ['uninstall', BREW_FORMULA_TARGET], { timeout: 180_000 });
    }
  } catch (e) {
    return { ok: false, message: `卸载失败：${extractErr(e)}` };
  }

  const after = await rtkStatus();
  return after.installed
    ? { ok: false, message: `卸载命令执行了但 rtk 仍可用：${after.detail}` }
    : { ok: true, message: '已卸载 RTK' };
}

/** 从 execFile 的 error 里抽人话（stderr 优先，截断防刷屏） */
function extractErr(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  const raw = (err?.stderr && String(err.stderr).trim()) || err?.message || String(e);
  return raw.split('\n').filter((l) => l.trim()).slice(0, 3).join(' / ').slice(0, 300);
}
