// 标准余额接口 provider（DeepSeek / Moonshot / 智谱 GLM）
//
// 这三个平台的共性是：提供 HTTP 接口查余额，需要用户在设置里填 key 或复用 CC Switch。
// 与火山的 subprocess 模式、OpenCode 的固定端点不同，这里用一张描述表驱动，
// 加新平台只需要在 BALANCE_APIS 里加一条，不改逻辑。
//
// 实测确认的返回结构：
//   DeepSeek  GET /user/balance
//     {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"11.40",...}]}
//   智谱 GLM  GET /api/monitor/usage/quota/limit
//     {"code":200,"data":{"limits":[{"type":"CREDIT_LIMIT","usage":2000,"remaining":2000,
//       "percentage":0,"nextResetTime":1793847267998}],"level":"lite"}}
//     （这个其实是「额度」不是现金余额，所以走 RateWindow 而不是 Balance）

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderQuota, RateWindow } from '../types.js';
import { resolveKey } from '../credentials.js';

const execFileP = promisify(execFile);

async function httpJson(url: string, key: string, authHeader: 'bearer' | 'raw' = 'bearer'): Promise<
  { ok: true; data: unknown } | { ok: false; error: string }
> {
  const script = `
import json, sys, urllib.request
hdr = {
    'User-Agent': 'token-pilot',
    'Accept': 'application/json',
    'Authorization': ('Bearer ' if sys.argv[3] == 'bearer' else '') + sys.argv[2],
}
req = urllib.request.Request(sys.argv[1], headers=hdr)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(r.read().decode())
except Exception as e:
    print(json.dumps({'__error': str(e)}))
`;
  try {
    const { stdout } = await execFileP(
      'python3',
      ['-c', script, url, key, authHeader],
      { timeout: 20_000 },
    );
    const d = JSON.parse(stdout) as { __error?: string };
    if (d.__error) return { ok: false, error: d.__error };
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 150) };
  }
}

/** DeepSeek：现金余额 */
export async function fetchDeepseekBalance(): Promise<ProviderQuota> {
  const base: ProviderQuota = {
    id: 'deepseek',
    displayName: 'DeepSeek',
    source: 'api',
    ok: false,
    fetchedAt: Date.now(),
  };
  const cred = await resolveKey('deepseek', 'deepseek');
  if (!cred) {
    return { ...base, error: '未配置 API Key（看板设置里填，或装了 CC Switch 可自动读取）' };
  }

  const r = await httpJson('https://api.deepseek.com/user/balance', cred.key);
  if (!r.ok) {
    return {
      ...base,
      error: /401|403/.test(r.error) ? 'API Key 无效或已过期' : r.error,
    };
  }

  const d = r.data as {
    is_available?: boolean;
    balance_infos?: { currency?: string; total_balance?: string }[];
  };
  const info = (d.balance_infos ?? [])[0];
  const amount = info?.total_balance ? Number(info.total_balance) : NaN;
  if (!Number.isFinite(amount)) {
    return { ...base, error: '接口没有返回可解析的余额' };
  }

  return {
    ...base,
    ok: true,
    balance: { amount, currency: (info?.currency === 'USD' ? 'USD' : 'CNY') as 'CNY' | 'USD' },
    note: d.is_available === false ? '账户当前不可用（可能欠费）' : cred.detail,
  };
}

/** 智谱 GLM：额度（不是现金余额，是积分制套餐） */
export async function fetchGlmQuota(): Promise<ProviderQuota> {
  const base: ProviderQuota = {
    id: 'glm',
    displayName: '智谱 GLM',
    source: 'api',
    ok: false,
    fetchedAt: Date.now(),
  };
  const cred = await resolveKey('glm', 'GLM');
  if (!cred) {
    return { ...base, error: '未配置 API Key（看板设置里填，或装了 CC Switch 可自动读取）' };
  }

  const r = await httpJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', cred.key);
  if (!r.ok) {
    return { ...base, error: /401|403/.test(r.error) ? 'API Key 无效或已过期' : r.error };
  }

  const d = r.data as {
    code?: number;
    data?: {
      level?: string;
      limits?: {
        type?: string;
        usage?: number;
        remaining?: number;
        percentage?: number;
        nextResetTime?: number;
      }[];
    };
  };
  const limits = d.data?.limits ?? [];
  if (limits.length === 0) {
    return { ...base, error: '没有查到额度信息（可能未订阅套餐）' };
  }

  // unit/number 组合表示窗口长度，实测没给出明确的天/小时语义，
  // 所以只按出现顺序编号，不猜具体时长（猜错会让「节奏」计算失真）
  const windows: RateWindow[] = limits.map((l, i) => ({
    id: `glm-${l.type ?? i}`,
    label: `额度窗口 ${i + 1}`,
    percent: typeof l.percentage === 'number' ? l.percentage : 0,
    used: typeof l.usage === 'number' ? l.usage : undefined,
    total: typeof l.usage === 'number' ? l.usage : undefined,
    resetsAt:
      typeof l.nextResetTime === 'number'
        ? new Date(l.nextResetTime).toISOString()
        : undefined,
    unit: 'credits',
  }));

  return {
    ...base,
    ok: true,
    windows,
    note: `${cred.detail}；套餐档位 ${d.data?.level ?? '未知'}`,
  };
}

/** MiniMax：token plan 剩余额度 */
export async function fetchMinimaxTokenPlan(): Promise<ProviderQuota> {
  const base: ProviderQuota = {
    id: 'minimax',
    displayName: 'MiniMax',
    source: 'api',
    ok: false,
    fetchedAt: Date.now(),
  };
  const cred = await resolveKey('minimax', 'minimax');
  if (!cred) {
    return { ...base, error: '未配置 API Key（看板设置里填，或装了 CC Switch 可自动读取）' };
  }

  const r = await httpJson('https://api.minimaxi.com/v1/token_plan/remains', cred.key);
  if (!r.ok) {
    return { ...base, error: /401|403/.test(r.error) ? 'API Key 无效或已过期' : r.error };
  }

  const d = r.data as {
    model_remains?: unknown;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const code = d.base_resp?.status_code ?? 0;
  if (code !== 0) {
    // 2062 = 没有生效的 token plan 订阅，这是正常状态而非错误
    const msg = d.base_resp?.status_msg ?? `status_code ${code}`;
    return {
      ...base,
      error: /no active token plan/i.test(msg) ? '当前没有生效的 Token Plan 订阅' : msg,
    };
  }

  // model_remains 的实际结构未实测（本机账号无订阅），按可能字段宽松解析
  const mr = d.model_remains as
    | { remaining_tokens?: number; total_tokens?: number; used_tokens?: number }
    | null;
  if (!mr) {
    return { ...base, error: '接口返回里没有 model_remains 数据' };
  }

  const total = typeof mr.total_tokens === 'number' ? mr.total_tokens : undefined;
  const used = typeof mr.used_tokens === 'number' ? mr.used_tokens : undefined;
  const remaining = typeof mr.remaining_tokens === 'number' ? mr.remaining_tokens : undefined;

  return {
    ...base,
    ok: true,
    tokenPlan: {
      planName: 'MiniMax Token Plan',
      usedTokens: used,
      totalTokens: total,
      remainingTokens: remaining,
      percent:
        total && used != null ? Math.round((used / total) * 1000) / 10 : undefined,
    },
    note: `${cred.detail}；结构为按字段宽松解析（本机无订阅实测样本）`,
  };
}
