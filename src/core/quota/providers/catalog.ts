// 内置平台目录 —— 声明式描述「怎么查这个平台的余额/额度」。
//
// 为什么要有这个文件：原来的 balance.ts 是**每个平台一个专用函数**，
// 加一个平台就要写代码 + 发版，用户也没法自己加。
// 现在把「端点 + 鉴权方式 + 怎么从 JSON 里取数」抽成数据，
// 加平台 = 往这个数组里加一条，不用改逻辑。
//
// ⚠️ verified 字段是硬门槛：
//   只写「端点存在」不够——很多网关对不存在的路径也返回 401，
//   光看状态码会把不存在的接口当成存在（踩过一次：GLM 的 401 是误判）。
//   所以只有用**真实 key 打出真实 JSON**、确认字段路径无误的平台才填日期，
//   没验过的一律 verified: null，运行时跳过并在 doctor 里标出来。

import type { Balance } from '../types.js';

/** 鉴权头的三种常见形态 */
export type AuthStyle =
  | 'bearer'   // Authorization: Bearer <key>
  | 'raw'      // Authorization: <key>（MiniMax / 部分国内平台）
  | 'x-api-key'; // x-api-key: <key>（Anthropic 系）

/** 从 JSON 里取出数值的路径描述 */
export interface FieldPath {
  /** 点号分隔的路径，如 'data.total_credits'；支持 [0] 下标 */
  path: string;
  /** 该字段是「余额」还是「已用额度」——决定 UI 怎么显示 */
  kind: 'balance' | 'remaining' | 'used';
  /** 数值换算：有些平台返回「分」，乘 0.01 才是元 */
  scale?: number;
  /**
   * 需要相减的第二个字段路径。
   *
   * 存在的必要：有些平台根本不返回「余额」，只给
   * 「累计充值 total_credits」和「累计已用 total_usage」两个数。
   * 余额 = credits - usage。直接把 credits 当余额会显示成「你还剩 ¥0.34」，
   * 而实际上一分不剩——这比报错更危险，用户会以为自己还有钱。
   * （OpenRouter 就是这种结构，2026-11 实测确认）
   */
  subtractPath?: string;
}

export interface BalanceApiSpec {
  /** 稳定 id，同时作为 quotaKeys 的键名 */
  id: string;
  displayName: string;
  /** 完整端点 URL */
  endpoint: string;
  auth: AuthStyle;
  /** 额外请求头（有些平台要求 Anthropic-Version 之类） */
  headers?: Record<string, string>;
  /** 取哪个字段作为金额 */
  amount: FieldPath;
  /** 币种；平台返回里带币种时留空，由解析器从响应里读 */
  currency?: 'CNY' | 'USD';
  /** 响应里表示币种的字段路径（优先于上面的固定值） */
  currencyPath?: string;
  /** 告诉用户去哪申请 key */
  keyUrl: string;
  /** 实测通过的日期；null = 未验证，运行时跳过 */
  verified: string | null;
  /** 附加说明，直接展示给用户 */
  note?: string;
}

/**
 * 内置目录。
 *
 * 目前只有 verified 非空的会被启用。表里保留未验证条目不是摆设——
 * 它们记录了「端点探测结果」，避免以后重复调研，
 * 也方便有人提供 key 时直接补测。
 */
export const BALANCE_CATALOG: BalanceApiSpec[] = [
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/user/balance',
    auth: 'bearer',
    // 返回结构：{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"11.40"}]}
    amount: { path: 'balance_infos[0].total_balance', kind: 'balance' },
    currencyPath: 'balance_infos[0].currency',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    // 历史实现已在生产使用，结构由真实 key 确认
    verified: '2026-10-29',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot / Kimi',
    endpoint: 'https://api.moonshot.cn/v1/users/me/balance',
    auth: 'bearer',
    // 返回结构：{"code":0,"data":{"available_balance":<number>,"voucher_balance":...,"cash_balance":...}}
    amount: { path: 'data.available_balance', kind: 'balance' },
    currency: 'CNY',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    verified: null, // 端点存在（401）但尚未用真实 key 验证字段路径
    note: '待用真实 key 核实字段名',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/credits',
    auth: 'bearer',
    // 实测（2026-11-05，真实 key）：{"data":{"total_credits":0.339163134,
    //   "total_usage":0.339163134}}
    // 注意：total_credits 是**累计充值**不是余额，必须减去 total_usage。
    // 直接拿 credits 当余额会显示「还剩 $0.34」，而实际剩余是 0。
    amount: {
      path: 'data.total_credits',
      subtractPath: 'data.total_usage',
      kind: 'balance',
    },
    currency: 'USD',
    keyUrl: 'https://openrouter.ai/keys',
    verified: '2026-11-05',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    endpoint: 'https://api.minimaxi.com/v1/token_plan/remains',
    auth: 'raw',
    // 这是 Token Plan（预付包），不是现金余额；由现有 minimax provider 处理
    amount: { path: 'model_remains[0].current_interval_total_count', kind: 'remaining' },
    currency: 'CNY',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    verified: null,
    note: 'Token Plan 不是现金余额，走独立解析器',
  },
];

/** 取已启用的条目（verified 非空） */
export function verifiedSpecs(): BalanceApiSpec[] {
  return BALANCE_CATALOG.filter((s) => s.verified !== null);
}

/** 按 id 取条目 */
export function specById(id: string): BalanceApiSpec | undefined {
  return BALANCE_CATALOG.find((s) => s.id === id);
}

/** 按路径从 JSON 取数，支持 a.b[0].c 这种写法 */
export function readPath(obj: unknown, pathStr: string): unknown {
  let cur: unknown = obj;
  for (const raw of pathStr.split('.')) {
    if (cur == null) return undefined;
    // 处理 key[0] 形式
    const m = raw.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    const [, key, indexes] = m;
    if (key) {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    for (const idx of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

/** 把任意值转成有限数字，转不了返回 null（不猜、不默认 0） */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 从响应里取余额，取不到返回 null（UI 显示「解析失败」，绝不显示 0） */
export function extractBalance(spec: BalanceApiSpec, data: unknown): Balance | null {
  const raw = readPath(data, spec.amount.path);
  let n = toNumber(raw);
  if (n === null) return null;
  // 两字段相减：任一字段缺失或非数字就不算——宁可报错也不猜余额
  if (spec.amount.subtractPath) {
    const sub = toNumber(readPath(data, spec.amount.subtractPath));
    if (sub === null) return null;
    n = n - sub;
  }
  const scaled = spec.amount.scale ? n * spec.amount.scale : n;
  let currency: 'CNY' | 'USD' = spec.currency ?? 'CNY';
  if (spec.currencyPath) {
    const c = readPath(data, spec.currencyPath);
    if (typeof c === 'string' && c.toUpperCase() === 'USD') currency = 'USD';
    else if (typeof c === 'string' && c.toUpperCase() === 'CNY') currency = 'CNY';
  }
  return { amount: scaled, currency };
}
