// RTK（Rust Token Killer）接入层 — 用户显式勾选才安装；rtk-oss 纯 Apache 版
// 原则：少采集/不拦截——rtk 是独立的输出压缩工具，token-pilot 只负责装/检测/卸载，不嵌进请求链。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function rtkInstalled(): Promise<boolean> {
  try {
    const r = await execFileP('rtk', ['--version'], { timeout: 5000 });
    return (r.stdout + r.stderr).length > 0;
  } catch {
    return false;
  }
}

export interface RtkInstallResult {
  ok: boolean;
  message: string;
}

// 安装 rtk-oss（纯 Apache 版）：macOS/Linux 走 brew，Windows 走 winget
export async function installRtk(): Promise<RtkInstallResult> {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      await execFileP('winget', ['install', '--id', 'rtk-ai.rtk-oss', '-e', '--accept-source-agreements', '--accept-package-agreements'], { timeout: 300_000 });
    } else {
      // 优先 rtk-oss tap；没有 tap 就 brew 主仓库的 rtk
      try {
        await execFileP('brew', ['install', 'rtk-ai/tap/rtk-oss'], { timeout: 300_000 });
      } catch {
        await execFileP('brew', ['install', 'rtk'], { timeout: 300_000 });
      }
    }
    const ok = await rtkInstalled();
    return ok
      ? { ok: true, message: 'RTK 已安装（rtk --version 验证通过）' }
      : { ok: false, message: '安装命令执行了但 rtk --version 未通过，请手动检查' };
  } catch (e) {
    return { ok: false, message: `安装失败：${String(e).slice(0, 200)}` };
  }
}

export async function uninstallRtk(): Promise<RtkInstallResult> {
  try {
    if (process.platform === 'win32') {
      await execFileP('winget', ['uninstall', '--id', 'rtk-ai.rtk-oss', '-e'], { timeout: 180_000 });
    } else {
      try { await execFileP('brew', ['uninstall', 'rtk-oss'], { timeout: 180_000 }); }
      catch { await execFileP('brew', ['uninstall', 'rtk'], { timeout: 180_000 }); }
    }
    return { ok: true, message: '已卸载 RTK' };
  } catch (e) {
    return { ok: false, message: `卸载失败：${String(e).slice(0, 200)}` };
  }
}
