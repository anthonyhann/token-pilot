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
import { explainQuotaError } from '../errors.js';
import { resolveKey } from '../credentials.js';
import type { ProviderQuota } from '../types.js';
import {
  BALANCE_CATALOG,
  extractBalance,
  verifiedSpecs,
  type AuthStyle,
  type BalanceApiSpec,
} from './catalog.js';

/** 用户自定义平台：只允许字段并集，避免任意对象混进来 */
export interface CustomEndpoint {
  id: string;
  displayName: string;
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
    endpoint: c.endpoint,
    auth: c.auth,
    amount: { path: c.amountPath, kind: 'balance' },
    currency: c.currency,
    keyUrl: '',
    verified: 'custom', // 自定义条目不参与「未验证不启用」的过滤，用户自己负责
    note: '自定义端点',
  };
}

/** 用 python3 发 GET 请求（与项目其它网络调用保持一致，不引入 npm 依赖） */
function buildScript(spec: BalanceApiSpec): string {
  const headerExpr =
    spec.auth === 'x-api-key'
      ? `'x-api-key': sys.argv[2]`
      : spec.auth === 'raw'
        ? `'Authorization': sys.argv[2]`
        : `'Authorization': 'Bearer ' + sys.argv[2]`;
  const extra = spec.headers
    ? Object.entries(spec.headers)
        .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
        .join('\n')
    : '';
  return `
import json, sys, urllib.request
hdr = {
    'User-Agent': 'token-pilot',
    'Accept': 'application/json',
    ${headerExpr},
${extra}
}
req = urllib.request.Request(sys.argv[1], headers=hdr)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(r.read().decode())
except Exception as e:
    print(json.dumps({'__error': str(e)}))
`;
}

interface HttpResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function httpGet(spec: BalanceApiSpec, key: string): Promise<HttpResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP(
      'python3',
      ['-c', buildScript(spec), spec.endpoint, key],
      { timeout: 20_000 },
    );
    const parsed = JSON.parse(stdout) as { __error?: string };
    if (parsed.__error) return { ok: false, error: explainQuotaError(parsed.__error) };
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: explainQuotaError(String(e).slice(0, 150)) };
  }
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
    : await resolveKey(spec.id);
  if (!cred) {
    return {
      ...base,
      error: `未配置 API Key（在设置里填，或装了 CC Switch 可自动读取）${spec.keyUrl ? `；申请地址：${spec.keyUrl}` : ''}`,
    };
  }

  const res = await httpGet(spec, cred.key);
  if (!res.ok) {
    return { ...base, error: res.error ?? '请求失败' };
  }

  const balance = extractBalance(spec, res.data);
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
  return BALANCE_CATALOG.filter((s) => s.verified === null);
}
