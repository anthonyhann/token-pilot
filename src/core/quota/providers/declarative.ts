// 通用余额查询引擎 —— 按 catalog 里的声明执行查询。
//
// 与 balance.ts 的区别：那边是「一个平台一个函数」，这里是「一份描述跑所有平台」。
// 加新平台只需在 catalog.ts 加一条，不用碰这个文件。
//
// 三条硬约束：
//   1. 只有 verified 非空的条目会被执行（没实测过的端点不许上线）
//   2. 解析不出数字就报错，绝不返回 0——显示 ¥0 比显示错误更误导
//   3. 请求只发往 key 所属平台自己的域名，不经任何中转

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { noKeyMessage } from '../errors.js';
import { httpGetJson, type HttpJsonResult } from '../http.js';
import { resolveKey } from '../credentials.js';
import type { ProviderQuota } from '../types.js';
import {
  API_CATALOG,
  extractAmount,
  verifiedSpecs,
  keySlot,
  type AuthStyle,
  type ApiSpec,
  type BalanceApiSpec,
  type QuotaScenario,
} from './catalog.js';

/** 用户自定义平台：只允许字段并集，避免任意对象混进来 */
export interface CustomEndpoint {
  id: string;
  displayName: string;
  /** 这条自定义端点属于余额场景还是订阅场景 */
  scenario?: QuotaScenario;
  endpoint: string;
  auth: AuthStyle;
  /** 金额字段路径 */
  amountPath: string;
  currency?: 'CNY' | 'USD';
}

const CUSTOM_PATH = path.join(os.homedir(), '.token-pilot', 'custom-endpoints.json');

/** 读用户自定义端点。文件不存在或损坏都返回空数组，不抛错。 */
export async function loadCustomEndpoints(): Promise<CustomEndpoint[]> {
  try {
    const raw = await fs.readFile(CUSTOM_PATH, 'utf8');
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    // 逐个洗一遍：缺字段、类型不对的条目直接丢弃，不带着坏数据跑
    return arr.filter((e): e is CustomEndpoint => {
      if (!e || typeof e !== 'object') return false;
      const o = e as Record<string, unknown>;
      return (
        typeof o.id === 'string' && o.id.trim() !== '' &&
        typeof o.displayName === 'string' &&
        typeof o.endpoint === 'string' && /^https:\/\//.test(o.endpoint) &&
        (o.auth === 'bearer' || o.auth === 'raw' || o.auth === 'x-api-key') &&
        typeof o.amountPath === 'string' && o.amountPath.trim() !== ''
      );
    }).map((e) => ({
      id: e.id.trim(),
      displayName: e.displayName.trim() || e.id.trim(),
      endpoint: e.endpoint.trim(),
      auth: e.auth,
      amountPath: e.amountPath.trim(),
      currency: e.currency === 'USD' ? 'USD' : 'CNY',
    }));
  } catch {
    return [];
  }
}

/** 保存自定义端点（整体覆盖） */
export async function saveCustomEndpoints(list: CustomEndpoint[]): Promise<void> {
  await fs.mkdir(path.dirname(CUSTOM_PATH), { recursive: true });
  await fs.writeFile(CUSTOM_PATH, JSON.stringify(list, null, 2), 'utf8');
}

/** 把自定义端点包装成和内置条目同构的 spec，好复用同一套请求/解析逻辑 */
function customToSpec(c: CustomEndpoint): BalanceApiSpec {
  return {
    id: c.id,
    displayName: c.displayName,
    scenario: c.scenario ?? 'balance',
    endpoint: c.endpoint,
    auth: c.auth,
    amount: { path: c.amountPath, kind: 'balance' },
    currency: c.currency,
    keyUrl: '',
    verified: 'custom', // 自定义条目不参与「未验证不启用」过滤，用户自己负责
    note: '自定义端点',
  };
}

/** 按 spec 的鉴权形态组装请求头 */
function authHeaders(spec: BalanceApiSpec, key: string): Record<string, string> {
  const h: Record<string, string> = { ...(spec.headers ?? {}) };
  if (spec.auth === 'x-api-key') h['x-api-key'] = key;
  else if (spec.auth === 'raw') h['Authorization'] = key;
  else h['Authorization'] = `Bearer ${key}`;
  return h;
}

function httpGet(spec: BalanceApiSpec, key: string): Promise<HttpJsonResult> {
  return httpGetJson(spec.endpoint, authHeaders(spec, key));
}

/**
 * 用一个**指定**的 key 查一次，不读本地凭证。
 *
 * 给「测试连接」用：用户刚在输入框里粘了 key、还没保存，
 * 必须能先验证它对不对。存完再测等于让人先存错的。
 */
export async function testWithKey(
  spec: BalanceApiSpec,
  key: string,
): Promise<ProviderQuota> {
  return fetchDeclarativeBalance(spec, key);
}

/**
 * 查一个平台。失败时返回 ok:false + 人话原因，绝不编造数字。
 *
 * @param overrideKey 传了就跳过本地凭证解析（测试连接场景）
 */
export async function fetchDeclarativeBalance(
  spec: BalanceApiSpec,
  overrideKey?: string,
): Promise<ProviderQuota> {
  const base: ProviderQuota = {
    id: spec.id,
    displayName: spec.displayName,
    source: 'api',
    ok: false,
    fetchedAt: Date.now(),
  };

  const cred = overrideKey
    ? { key: overrideKey, origin: 'config' as const, detail: '本次输入的 key' }
    : await resolveKey(spec.id, undefined, spec.scenario);
  if (!cred) {
    return { ...base, error: noKeyMessage(spec.keyUrl || undefined) };
  }

  const res = await httpGet(spec, cred.key);
  if (!res.ok) {
    return { ...base, error: res.error ?? '请求失败' };
  }

  const balance = extractAmount(spec, res.data);
  if (!balance) {
    // 拿到了响应但解析不出钱数：常见于 key 有效但账户没开通、
    // 或平台改了字段名。把原始响应截一段带上，便于排查，但不猜数字。
    const snippet = JSON.stringify(res.data).slice(0, 160);
    return {
      ...base,
      error: `接口返回里找不到余额字段 ${spec.amount.path}，可能平台改了结构。原始响应：${snippet}`,
    };
  }

  return {
    ...base,
    ok: true,
    balance,
    note: spec.note ?? cred.detail,
  };
}

/** 测试连接的单条结果 */
export interface KeyTestResult {
  id: string;
  displayName: string;
  scenario: QuotaScenario;
  ok: boolean;
  /** 成功时给余额展示文案，如「¥20.10」 */
  detail?: string;
  error?: string;
  /**
   * 订阅场景才有：查到的套餐名与月费。
   * 月费拿不到时 monthlyCny 为空——不猜价格，界面提示用户手填。
   */
  planName?: string;
  monthlyCny?: number;
}

/**
 * 「测试连接」的统一实现。
 *
 * 为什么放在 core 而不是 serve：桌面端（Tauri）里没有本地 serve，
 * 前端 fetch('/api/...') 必然失败。逻辑必须能在两种宿主里复用，
 * 所以抽成纯函数，由 serve 的路由和 Tauri 命令各自调用。
 *
 * @param overrideKeys 本次界面上输入的 key（id → key）。
 *   传了就优先用它们——用户刚粘的 key 还没保存，必须先能验证。
 * @param customs 本次界面上新增、还没落盘的自定义端点。
 */
export async function testEndpoints(
  overrideKeys: Record<string, string> = {},
  customs: CustomEndpoint[] = [],
): Promise<KeyTestResult[]> {
  const saved = await loadCustomEndpoints();
  // 界面上新增的 + 已保存的，按 id 去重（界面上的优先，可能是刚改过的）
  const byId = new Map<string, CustomEndpoint>();
  for (const c of saved) byId.set(c.id, c);
  for (const c of customs) byId.set(c.id, c);

  const specs: BalanceApiSpec[] = [...verifiedSpecs(), ...[...byId.values()].map(customToSpec)];

  return Promise.all(
    specs.map(async (spec) => {
      // 界面传上来的键是 `平台:场景`，兼容旧的无场景写法
      const override =
        overrideKeys[keySlot(spec.id, spec.scenario)]?.trim() ?? overrideKeys[spec.id]?.trim();
      const probe = await fetchDeclarativeBalance(spec, override || undefined).catch((e) => ({
        ok: false,
        error: String(e).slice(0, 150),
      }));
      const balance = 'balance' in probe ? probe.balance : undefined;
      const tp = 'tokenPlan' in probe ? probe.tokenPlan : undefined;
      return {
        id: spec.id,
        displayName: spec.displayName,
        scenario: spec.scenario,
        ok: probe.ok,
        detail:
          probe.ok && balance
            ? `${balance.currency === 'CNY' ? '¥' : '$'}${balance.amount.toFixed(2)}`
            : undefined,
        error: probe.ok ? undefined : ('error' in probe ? String(probe.error) : '失败'),
        planName: tp?.planName,
        monthlyCny: tp?.monthlyCny,
      };
    }),
  );
}

/** 全部内置已启用平台 + 用户自定义平台 */
export async function fetchAllDeclarative(): Promise<ProviderQuota[]> {
  const customs = await loadCustomEndpoints();
  const specs = [...verifiedSpecs(), ...customs.map(customToSpec)];
  const results = await Promise.allSettled(specs.map((s) => fetchDeclarativeBalance(s)));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          id: specs[i].id,
          displayName: specs[i].displayName,
          source: 'api' as const,
          ok: false,
          error: String(r.reason).slice(0, 200),
          fetchedAt: Date.now(),
        },
  );
}

/** 给 doctor 用：列出还没验证、因此未启用的平台 */
export function unverifiedSpecs(): BalanceApiSpec[] {
  return API_CATALOG.filter((s) => s.verified === null);
}
