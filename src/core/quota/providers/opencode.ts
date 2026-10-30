// OpenCode（Go / Zen）额度
//
// 接口：GET https://opencode.ai/zen/go/v1/usage
// 鉴权：Authorization: Bearer <oc_sk_...>
//
// 本机实测返回（2026-10-29）：
//   {
//     "usage": {
//       "rolling": { "status": "ok", "percent": 0,  "resetsAt": "2026-10-29T11:47:19.154Z" },
//       "weekly":  { "status": "ok", "percent": 1,  "resetsAt": "2026-11-02T00:00:00.000Z" },
//       "monthly": { "status": "ok", "percent": 98, "resetsAt": "2026-11-09T03:09:52.000Z" }
//     }
//   }
//
// 之所以优先做这个而不是「等用户配 key」：OpenCode 的凭证本来就在
// ~/.local/share/opencode/auth.json，不需要用户做任何事。

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProviderQuota, RateWindow } from '../types.js';
import { fromConfig, fromCcSwitch } from '../credentials.js';
import { explainQuotaError } from '../errors.js';

const execFileP = promisify(execFile);

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

/** 窗口 id → 中文名 + 时长（分钟） */
const WINDOWS: Record<string, { label: string; minutes: number }> = {
  rolling: { label: '滚动窗口', minutes: 5 * 60 },
  weekly: { label: '本周', minutes: 7 * 24 * 60 },
  monthly: { label: '本月', minutes: 30 * 24 * 60 },
};

interface OpencodeUsageResponse {
  usage?: Record<string, { status?: string; percent?: number; resetsAt?: string }>;
}

/** 从 OpenCode 自己的 auth.json 取 key（不依赖 CC Switch） */
function fromOpencodeNative(): string | null {
  const p = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8')) as Record<string, { key?: string }>;
    // 优先 opencode-go，其次任意 oc_sk_ 开头的
    if (d['opencode-go']?.key) return d['opencode-go'].key;
    for (const v of Object.values(d)) {
      if (v?.key?.startsWith('oc_sk_')) return v.key;
    }
  } catch {
    /* 解析失败按无凭证处理 */
  }
  return null;
}

async function resolveOpencodeKey(): Promise<{ key: string; detail: string } | null> {
  const cfg = fromConfig('opencode');
  if (cfg) return { key: cfg.key, detail: cfg.detail };

  const native = fromOpencodeNative();
  if (native) {
    return { key: native, detail: '来自 OpenCode 的登录凭据（~/.local/share/opencode/auth.json）' };
  }

  const ccs = await fromCcSwitch('opencode');
  if (ccs) return { key: ccs.key, detail: ccs.detail };
  return null;
}

async function httpGetJson(url: string, key: string): Promise<unknown> {
  const script = `
import json, sys, urllib.request
req = urllib.request.Request(sys.argv[1], headers={
    'Authorization': 'Bearer ' + sys.argv[2],
    # 服务端会按 User-Agent 拦请求：不带 UA 时 urllib 默认的 Python-urllib/x.y 会 403
    'User-Agent': 'token-pilot',
    'Accept': 'application/json',
})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(r.read().decode())
except Exception as e:
    print(json.dumps({'__error': str(e)}))
`;
  try {
    const { stdout } = await execFileP('python3', ['-c', script, url, key], { timeout: 20_000 });
    return JSON.parse(stdout);
  } catch (e) {
    return { __error: String(e).slice(0, 150) };
  }
}

export async function fetchOpencodeQuota(): Promise<ProviderQuota> {
  const base: ProviderQuota = {
    id: 'opencode',
    displayName: 'OpenCode Go',
    source: 'api',
    ok: false,
    fetchedAt: Date.now(),
  };

  const cred = await resolveOpencodeKey();
  if (!cred) {
    return { ...base, error: '未找到 OpenCode 凭据（需先在 OpenCode 里登录，或在设置里填 key）' };
  }

  const res = (await httpGetJson(USAGE_URL, cred.key)) as OpencodeUsageResponse & {
    __error?: string;
  };
  if (res.__error) {
    const hint = /401/.test(res.__error)
      ? '凭证无效或已过期，请在 OpenCode 里重新登录'
      : /403/.test(res.__error)
        ? '接口拒绝访问（403）——若刚登录过请重试'
        : explainQuotaError(res.__error);
    return { ...base, error: hint };
  }
  if (!res.usage) {
    return { ...base, error: '接口返回里没有 usage 字段' };
  }

  // 按 rolling → weekly → monthly 的固定顺序输出，避免顺序抖动
  const order = ['rolling', 'weekly', 'monthly'];
  const windows: RateWindow[] = [];
  for (const id of order) {
    const u = res.usage[id];
    if (!u) continue;
    const meta = WINDOWS[id];
    windows.push({
      id: `opencode-${id}`,
      label: meta?.label ?? id,
      percent: typeof u.percent === 'number' ? u.percent : 0,
      resetsAt: u.resetsAt,
      windowMinutes: meta?.minutes,
      unit: 'requests',
    });
  }

  // 只留我们认识的窗口，未知 id 也带上但不猜时长
  for (const [id, u] of Object.entries(res.usage)) {
    if (order.includes(id)) continue;
    windows.push({
      id: `opencode-${id}`,
      label: id,
      percent: typeof u.percent === 'number' ? u.percent : 0,
      resetsAt: u.resetsAt,
    });
  }

  return {
    ...base,
    ok: windows.length > 0,
    windows,
    note: `${cred.detail}；仅有百分比，平台不下发绝对额度`,
    error: windows.length === 0 ? '没有可用的额度窗口' : undefined,
  };
}
