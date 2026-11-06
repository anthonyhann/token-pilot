// API 型 provider：智谱 GLM 额度窗口 / MiniMax Token Plan
//
// 这两个平台的返回结构不是「一个余额数字」能表达的（GLM 是多额度窗口，
// MiniMax 是 token 套餐剩余量），放不进 catalog 的声明式模型，所以各保留
// 一个专用函数。标准余额平台（DeepSeek / Moonshot / OpenRouter）都在
// catalog.ts + declarative.ts，别往这里加。
//
// 实测确认的返回结构：
//   智谱 GLM  GET /api/monitor/usage/quota/limit
//     {"code":200,"data":{"limits":[{"type":"CREDIT_LIMIT","usage":2000,"remaining":2000,
//       "percentage":0,"nextResetTime":1793847267998}],"level":"lite"}}
//     （这个其实是「额度」不是现金余额，所以走 RateWindow 而不是 Balance）

import type { ProviderQuota, RateWindow } from '../types.js';
import { resolveKey } from '../credentials.js';
import { noKeyMessage } from '../errors.js';
import { httpGetJson } from '../http.js';

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
    return { ...base, error: noKeyMessage() };
  }

  const r = await httpGetJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
    Authorization: `Bearer ${cred.key}`,
  });
  if (!r.ok) {
    return { ...base, error: r.error };
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
    return { ...base, error: noKeyMessage() };
  }

  const r = await httpGetJson('https://api.minimaxi.com/v1/token_plan/remains', {
    Authorization: `Bearer ${cred.key}`,
  });
  if (!r.ok) {
    return { ...base, error: r.error };
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
