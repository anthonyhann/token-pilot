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

const BREW_FORMULA_OSS = 'rtk-ai/tap/rtk-oss';
const BREW_FORMULA_UPSTREAM = 'rtk';

async function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  try {
    const r = await execFileP(cmd, args, { timeout });
    return (r.stdout || '').trim();
  } catch {
    return null;
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
    const wl = await run('winget', ['list', '--id', 'rtk-ai.rtk-oss', '-e', '--accept-source-agreements'], 30_000);
    const ours = !!wl && wl.includes('rtk-ai.rtk-oss');
    return {
      installed: true,
      source: ours ? 'ours' : 'foreign',
      version: ver,
      detail: ours ? `已安装 rtk-oss ${ver}` : `已安装 ${ver}（来源不是 rtk-oss）`,
    };
  }

  const ver = await run('rtk', ['--version']);
  const hasOss = await brewHas('rtk-oss');
  const hasUpstream = await brewHas(BREW_FORMULA_UPSTREAM);

  if (!ver) {
    return { installed: false, source: 'none', version: '', detail: '未安装' };
  }
  if (hasOss) {
    return { installed: true, source: 'ours', version: ver, detail: `已安装 rtk-oss ${ver}` };
  }
  if (hasUpstream) {
    return {
      installed: true,
      source: 'foreign',
      version: ver,
      detail: `已安装 ${ver}，来源是 Homebrew 主仓库的 rtk（非 rtk-oss）`,
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
    return { ok: true, message: `RTK 已安装（${before.version}）` };
  }

  // 关键预检：系统里已存在别的来源的 rtk 时，rtk-oss 必然冲突
  if (before.installed && before.source === 'foreign') {
    return {
      ok: false,
      message:
        `检测到系统里已安装 ${before.version}，但来源不是 rtk-oss，两者都占用 rtk 命令、会互相冲突。` +
        (process.platform === 'win32'
          ? '请先卸载现有的 rtk 再勾选。'
          : `请先执行 \`brew uninstall ${BREW_FORMULA_UPSTREAM}\` 卸载它，再重新勾选。`),
    };
  }

  try {
    if (process.platform === 'win32') {
      await execFileP(
        'winget',
        ['install', '--id', 'rtk-ai.rtk-oss', '-e', '--accept-source-agreements', '--accept-package-agreements'],
        { timeout: 300_000 },
      );
    } else {
      // 只装 rtk-oss；不再回退到 brew install rtk（那是另一个包，且会制造假成功）
      await execFileP('brew', ['install', BREW_FORMULA_OSS], { timeout: 300_000 });
    }
  } catch (e) {
    return { ok: false, message: `安装失败：${extractErr(e)}` };
  }

  // 装完重新判定来源，不能只看 --version 能不能跑
  const after = await rtkStatus();
  if (after.installed && after.source === 'ours') {
    return { ok: true, message: `RTK 已安装（${after.version}）` };
  }
  if (after.installed) {
    return { ok: false, message: `安装命令执行完了，但检测到的 rtk 来源不对：${after.detail}` };
  }
  return { ok: false, message: '安装命令执行了但 rtk 命令仍不可用，请手动检查' };
}

export async function uninstallRtk(): Promise<RtkInstallResult> {
  const cur = await rtkStatus();
  if (!cur.installed) return { ok: true, message: 'RTK 未安装，无需卸载' };

  // 只卸载我们装的；别人的 rtk 不擅自删
  if (cur.source === 'foreign') {
    return { ok: false, message: `${cur.detail}——不是本工具安装的，为避免误删请手动卸载` };
  }

  try {
    if (process.platform === 'win32') {
      await execFileP('winget', ['uninstall', '--id', 'rtk-ai.rtk-oss', '-e'], { timeout: 180_000 });
    } else {
      await execFileP('brew', ['uninstall', 'rtk-oss'], { timeout: 180_000 });
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
