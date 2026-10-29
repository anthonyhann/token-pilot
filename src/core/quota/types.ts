// 额度与余额的统一数据模型
//
// 这里刻意分成三种类型，因为它们的经济含义完全不同，混在一起 UI 就没法正确显示：
//
//   RateWindow    —— 订阅套餐的时间窗口。到点自动重置，用超了要等下一轮。
//                    例：火山 Coding Plan 的 session/weekly/monthly。
//   TokenPlanQuota —— 预付费 token 包。买断制，用完就是没了，不会重置。
//                    例：MiniMax Token Plan、小米 MiMo token plan。
//   Balance       —— 现金账户余额。充多少花多少。
//                    例：DeepSeek / Moonshot / 智谱。
//
// 一个平台可以同时有多种（比如火山既有订阅套餐又有按量余额）。

/** 订阅套餐的单个时间窗口 */
export interface RateWindow {
  /** 稳定 id：session / weekly / monthly / 5h / 平台自定义 */
  id: string;
  /** 中文展示名，如「5 小时窗口」 */
  label: string;
  /** 已用百分比 0-100。所有平台都至少给这个 */
  percent: number;
  /**
   * 额度绝对值。只有部分平台提供：
   * 火山 Agent Plan 有 used/total；Coding Plan 只有 percent。
   * 缺失时 UI 不得编造，只显示百分比。
   */
  used?: number;
  total?: number;
  /** 下次重置时间（ISO 8601 带时区） */
  resetsAt?: string;
  /** 窗口时长（分钟），有它才能算「比线性节奏快还是慢」 */
  windowMinutes?: number;
  /** 额度单位，如 'AFP'、'requests'、'tokens' */
  unit?: string;
}

/** 预付费 token 包 */
export interface TokenPlanQuota {
  planName?: string;
  usedTokens?: number;
  totalTokens?: number;
  remainingTokens?: number;
  /** 已用百分比 0-100 */
  percent?: number;
  /** 套餐到期时间 */
  expiresAt?: string;
}

/** 现金余额 */
export interface Balance {
  amount: number;
  currency: 'CNY' | 'USD';
}

/** 数据的可信度来源——UI 上要标注，让用户知道哪些数字可信 */
export type QuotaSource = 'api' | 'cli' | 'manual' | 'computed';

/** 单个平台的额度快照 */
export interface ProviderQuota {
  /** 平台 id，如 'volc' / 'deepseek' / 'minimax' */
  id: string;
  /** 展示名 */
  displayName: string;
  source: QuotaSource;
  /** 拉取成功与否。失败时 error 说明原因，其它字段可能为空 */
  ok: boolean;
  error?: string;
  /** 订阅套餐的时间窗口 */
  windows?: RateWindow[];
  /** 预付费 token 包 */
  tokenPlan?: TokenPlanQuota;
  /** 现金余额 */
  balance?: Balance;
  /** 附加说明（如「Coding Plan 仅提供百分比，无绝对值」） */
  note?: string;
  /** 本次数据的获取时间（unix ms） */
  fetchedAt: number;
}

/** 全部平台的额度汇总 */
export interface QuotaSnapshot {
  generatedAt: number;
  providers: ProviderQuota[];
  /** 缓存是否命中（5 分钟 TTL） */
  cached?: boolean;
}

/**
 * 「比线性节奏快还是慢」。
 *
 * 这是整套额度监控里最有用的一个派生值：已用 60% 但窗口只过了 40%，
 * 说明照这个速度会在重置前用光，paceDelta = +20。
 *
 * 缺 resetsAt 或 windowMinutes 时返回 null（算不出来就说算不出来，不猜）。
 */
export function paceDelta(w: RateWindow, now: number = Date.now()): number | null {
  if (!w.resetsAt || !w.windowMinutes || w.windowMinutes <= 0) return null;
  const reset = Date.parse(w.resetsAt);
  if (Number.isNaN(reset)) return null;

  const totalMs = w.windowMinutes * 60_000;
  const leftMs = Math.max(0, Math.min(reset - now, totalMs));
  const elapsedFraction = (totalMs - leftMs) / totalMs;
  if (elapsedFraction < 0.02) return null; // 窗口刚开始，节奏判断没有意义

  return w.percent - elapsedFraction * 100;
}

/** 距离重置还有多久的人话描述 */
export function untilReset(w: RateWindow, now: number = Date.now()): string | null {
  if (!w.resetsAt) return null;
  const reset = Date.parse(w.resetsAt);
  if (Number.isNaN(reset)) return null;

  const ms = reset - now;
  if (ms <= 0) return '即将重置';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时 ${mins % 60} 分后`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时后`;
}

/** 额度紧张程度：用于状态栏取「最紧张的那个」，也用于 UI 着色 */
export function tension(q: ProviderQuota): number {
  // 百分比越高越紧张
  let max = 0;
  for (const w of q.windows ?? []) max = Math.max(max, w.percent);
  if (q.tokenPlan?.percent != null) max = Math.max(max, q.tokenPlan.percent);
  return max;
}
