// 平台余额 / 订阅查询目录 —— 声明式描述「怎么查」。
//
// 关键设计：**余额和订阅是两件事，用两套 key、两套端点**。
//   - 余额（balance）：现金账户还剩多少钱
//   - 订阅（subscription）：套餐用了多少、什么时候重置，往往要 admin key
// 很多平台两者权限不同（MiniMax 就是典型：普通 key 能查订阅，查余额要 admin key），
// 所以 key 按 `平台:场景` 分别存，互不覆盖。
//
// ⚠️ verified 是硬门槛：
//   只探测到 401 不算数——很多网关对不存在的路径也返 401（GLM 踩过）。
//   必须用真实 key 打出真实 JSON、确认字段路径无误，才填日期。
//   没验过的一律 null，运行时不启用。

import type { Balance } from '../types.js';

/** 鉴权头的三种常见形态 */
export type AuthStyle =
  | 'bearer' // Authorization: Bearer <key>
  | 'raw' // Authorization: <key>
  | 'x-api-key'; // x-api-key: <key>

/** 查询场景：余额 or 订阅 */
export type QuotaScenario = 'balance' | 'subscription';

/** 从 JSON 里取出数值的路径描述 */
export interface FieldPath {
  path: string;
  /** balance=余额，remaining=剩余，used=已用 */
  kind: 'balance' | 'remaining' | 'used';
  scale?: number;
  /** 需要相减的第二个字段（有些平台只给「累计充值」和「累计已用」） */
  subtractPath?: string;
}

export interface ApiSpec {
  /** 稳定 id，与场景拼成 `${id}:${scenario}` 作为 key 存储键 */
  id: string;
  displayName: string;
  scenario: QuotaScenario;
  endpoint: string;
  auth: AuthStyle;
  headers?: Record<string, string>;
  amount: FieldPath;
  currency?: 'CNY' | 'USD';
  currencyPath?: string;
  /** 告诉用户去哪申请 key */
  keyUrl: string;
  /** 该接口需要的 key 类型，用于提示 */
  keyKind?: 'normal' | 'admin';
  /** 实测通过日期；null = 未验证，运行时不启用 */
  verified: string | null;
  note?: string;
}

/**
 * 内置目录。
 *
 * 调研范围（2026-11）：国内 8 家 + 海外 6 家实测。结论：
 *   - 大多数平台**没有公开余额接口**（百川/零一万物/商汤/腾讯混元/阿里百炼 全 404）
 *   - OpenAI / Anthropic 只有组织级 admin 接口
 *   - 能接的不多不是做得少，是平台没开放
 * 未验证条目保留在表里不是摆设：记录探测结果避免重复调研，
 * 也方便拿到 key 时直接补测。
 */
export const API_CATALOG: ApiSpec[] = [
  // ───────── 余额 ─────────
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    scenario: 'balance',
    endpoint: 'https://api.deepseek.com/user/balance',
    auth: 'bearer',
    // {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"11.40"}]}
    amount: { path: 'balance_infos[0].total_balance', kind: 'balance' },
    currencyPath: 'balance_infos[0].currency',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyKind: 'normal',
    verified: '2026-10-29',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    scenario: 'balance',
    endpoint: 'https://openrouter.ai/api/v1/credits',
    auth: 'bearer',
    // 实测 2026-11-05：{"data":{"total_credits":0.339,"total_usage":0.339}}
    // total_credits 是累计充值不是余额，必须减去 total_usage；
    // 直接当余额会显示「还剩 $0.34」而实际剩余是 0
    amount: {
      path: 'data.total_credits',
      subtractPath: 'data.total_usage',
      kind: 'balance',
    },
    currency: 'USD',
    keyUrl: 'https://openrouter.ai/keys',
    keyKind: 'normal',
    verified: '2026-11-05',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot / Kimi',
    scenario: 'balance',
    endpoint: 'https://api.moonshot.cn/v1/users/me/balance',
    auth: 'bearer',
    // 实测 2026-11-05（真实 key）：
    // {"code":0,"data":{"available_balance":15,"voucher_balance":15,"cash_balance":0}}
    // available_balance = 代金券 + 现金，即真正可用的总额——就该显示它，
    // 单看 cash_balance 会显示 0（钱都在代金券里），那是误导。
    amount: { path: 'data.available_balance', kind: 'balance' },
    currency: 'CNY',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyKind: 'normal',
    verified: '2026-11-05',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    scenario: 'balance',
    endpoint: 'https://api.minimaxi.com/v1/account/balance',
    auth: 'bearer',
    // 实测 2026-11-05：普通 key 返回 403 token_type_mismatch
    // 「api key is not an admin key」——查余额必须 admin key
    amount: { path: 'data.balance', kind: 'balance' },
    currency: 'CNY',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    keyKind: 'admin',
    verified: null,
    // 实测 2026-11-05：两个普通 key（sk-api-...）都返回
    // 403 {"code":"token_type_mismatch","message":"api key is not an admin key"}。
    // 查余额必须到控制台单独创建 admin key，普通 API key 不行。
    note: '需要 admin key；实测普通 sk-api- key 报 token_type_mismatch',
  },
  {
    id: 'stepfun',
    displayName: '阶跃 StepFun',
    scenario: 'balance',
    endpoint: 'https://api.stepfun.com/v1/accounts/balance',
    auth: 'bearer',
    amount: { path: 'data.balance', kind: 'balance' },
    currency: 'CNY',
    keyUrl: 'https://platform.stepfun.com/interface-key',
    keyKind: 'normal',
    verified: null,
    // 实测 2026-11-05（真实有效 key，/v1/models 返回 200 证明 key 可用）：
    // 该端点返回 404 page not found —— 说明此前探测到的 401 是网关对
    // 未认证请求的统一拦截，并不代表端点存在。这正是「401 不能当存在证据」
    // 的又一个案例。
    // 另外试过 /v1/user/balance、/v1/account/balance、/v1/users/me/balance、
    // /v1/finance/balance、/v1/billing/balance、/v1/usage、/v1/open/balance、
    // /v1/dashboard/billing/credit_grants 等 8 个路径，全部 404。
    // 结论：StepFun 目前没有公开的余额查询接口，控制台可见但不能程序化读取。
    note:
      '无公开余额接口：官方文档（stepfun.mintlify.app）API 参考只有 chat 一个接口，' +
      '16 个管理端点实测全 404，key 本身有效（/v1/models 返回 200）。余额只能到控制台看',
  },

  // ───────── 从 CC Switch 反解出的新平台（2026-11-05）─────────
  // 这些端点是从 CC Switch.app 二进制里提取的（它有 src/commands/balance.rs）。
  // 端点存在性已用无 key 请求确认（返回鉴权错误而非 404），
  // 但字段结构未用真实 key 验证，所以 verified 仍为 null。
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow 硅基流动',
    scenario: 'balance',
    endpoint: 'https://api.siliconflow.cn/v1/user/info',
    auth: 'bearer',
    // CC Switch 里对应的字段名是 totalBalanceUSD
    amount: { path: 'data.totalBalance', kind: 'balance' },
    currency: 'CNY',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyKind: 'normal',
    verified: null,
    note: '端点存在（401 Token is invalid）；字段结构待真实 key 核实',
  },
  {
    id: 'novita',
    displayName: 'Novita AI',
    scenario: 'balance',
    endpoint: 'https://api.novita.ai/v3/user/balance',
    auth: 'bearer',
    amount: { path: 'availableBalance', kind: 'balance' },
    currency: 'USD',
    keyUrl: 'https://novita.ai/settings/key-management',
    keyKind: 'normal',
    verified: null,
    note: '端点存在（400 MISSING_API_KEY）；字段结构待真实 key 核实',
  },

  // ───────── 订阅 / 额度 ─────────
  {
    id: 'glm',
    displayName: '智谱 GLM',
    scenario: 'subscription',
    endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    auth: 'bearer',
    amount: { path: 'data.limits[0].remaining', kind: 'remaining' },
    currency: 'CNY',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyKind: 'normal',
    verified: null,
    note: '已由独立 provider 处理（多额度窗口），此处保留端点记录',
  },
  {
    id: 'kimi-coding',
    displayName: 'Kimi Code 订阅',
    scenario: 'subscription',
    endpoint: 'https://api.kimi.com/coding/v1/usages',
    auth: 'bearer',
    // CC Switch 解析的字段链：data.limits[].detail → remaining /
    // resetTime / five_hour / weekly_limit，以及 quota_5_hour / quota_7_day
    // （resets_at / used_value_usd / max_value_usd）
    amount: { path: 'data.limits[0].detail.remaining', kind: 'remaining' },
    currency: 'CNY',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyKind: 'normal',
    verified: null,
    note: 'Kimi Code 订阅额度（与余额是两个账号体系）；字段链来自 CC Switch 解析逻辑，待实测',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    scenario: 'subscription',
    endpoint: 'https://api.minimaxi.com/v1/token_plan/remains',
    auth: 'bearer',
    // 实测 2026-11-05：必须 Bearer，裸 key 报 1004「login fail」
    //（看着像 key 无效，其实是鉴权头格式错）
    amount: { path: 'model_remains[0].current_interval_total_count', kind: 'remaining' },
    currency: 'CNY',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    keyKind: 'normal',
    verified: null,
    // 实测 2026-11-05：key 有效（能过鉴权），但该账号无生效订阅，
    // 返回 2062 no active token plan subscription，拿不到 model_remains 结构，
    // 所以无法确认字段路径，暂不启用。
    note: '账号无生效 Token Plan 订阅（2062），字段结构未实测',
  },
];

/** 按场景取条目 */
export function specsFor(scenario: QuotaScenario): ApiSpec[] {
  return API_CATALOG.filter((s) => s.scenario === scenario);
}

/** 已启用的条目（verified 非空） */
export function verifiedSpecs(scenario?: QuotaScenario): ApiSpec[] {
  return API_CATALOG.filter(
    (s) => s.verified !== null && (!scenario || s.scenario === scenario),
  );
}

/** 未验证的条目（doctor 用） */
export function unverifiedSpecs(): ApiSpec[] {
  return API_CATALOG.filter((s) => s.verified === null);
}

export function specById(id: string, scenario: QuotaScenario): ApiSpec | undefined {
  return API_CATALOG.find((s) => s.id === id && s.scenario === scenario);
}

/** key 在 config 里的存储键：平台 + 场景 */
export function keySlot(id: string, scenario: QuotaScenario): string {
  return `${id}:${scenario}`;
}

/** 按路径从 JSON 取数，支持 a.b[0].c 写法 */
export function readPath(obj: unknown, pathStr: string): unknown {
  let cur: unknown = obj;
  for (const raw of pathStr.split('.')) {
    if (cur == null) return undefined;
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

/** 把任意值转成有限数字；转不了返回 null（不猜、不默认 0） */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 从响应里取金额，取不到返回 null（UI 显示解析失败，绝不显示 0） */
export function extractAmount(spec: ApiSpec, data: unknown): Balance | null {
  const raw = readPath(data, spec.amount.path);
  let n = toNumber(raw);
  if (n === null) return null;
  if (spec.amount.subtractPath) {
    const sub = toNumber(readPath(data, spec.amount.subtractPath));
    if (sub === null) return null;
    n -= sub;
  }
  if (spec.amount.scale) n *= spec.amount.scale;
  let currency: 'CNY' | 'USD' = spec.currency ?? 'CNY';
  if (spec.currencyPath) {
    const c = readPath(data, spec.currencyPath);
    if (typeof c === 'string' && c.toUpperCase() === 'USD') currency = 'USD';
    else if (typeof c === 'string' && c.toUpperCase() === 'CNY') currency = 'CNY';
  }
  return { amount: n, currency };
}

/** 兼容旧调用名 */
export const extractBalance = extractAmount;
export type BalanceApiSpec = ApiSpec;
