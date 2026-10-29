// DashboardData — 前端数据契约
// 两个前端（完整看板 / 菜单栏面板）都只吃这一份数据。
import type { QuotaSnapshot } from './quota/types.js';

// 金额一律给 USD 原始值 + 由前端按 usdToCny 折算展示；CNY 派生值在带 Cny 后缀的字段直接给好。

export interface HeroPill {
  icon: 'cal' | 'clk' | 'shd' | 'trd';
  label: string;      // '近 30 天' | '日均' | '本月预算剩' | '月底预计' | '今日' | '本周'
  value: string;      // 已格式化 '¥1,286'
}

export interface HeroPeriod {
  label: string;          // '今天已花费' / '本周已花费' / '本月已花费'
  costCny: number;
  tokens: number;         // 总 tokens
  outputTokens: number;
  calls: number;
  cacheHitRate: number;   // 0-1
  hosts: number;          // 活跃宿主数
  pills: HeroPill[];
}

export interface StatCard {
  value: string;          // 已格式化大数字，如 '9869万'
  sub: string;            // '日均 1.9亿'
  mini: number[];         // 14 根柱（0-100 归一化前的原值，前端归一）
}

export interface DayPoint {
  date: string;           // 'M/D'
  weekday: string;        // '周二'
  costUsd: number;
  tokens: number;
  calls: number;
}

export interface MixRow {
  name: string;
  costUsd: number;
  pct: number;            // 0-100
}

export interface RankRow {
  name: string;
  meta: string;           // 'Anthropic · 123 次调用 · 刚刚'
  costUsd: number;
  pct: number;            // 0-100
  sub?: string;           // '输出 18万 · 命中 97% · 88 tok/s'
  tier?: { label: string; cls: 'tier-1' | 'tier-2' | 'tier-0' };
  dim?: boolean;          // true = 未归一（无 token 数据）
}

export interface LiveSession {
  key: string;            // agent:sessionId
  agent: string;          // 宿主 id
  label: string;          // '/项目路径 · 首条用户消息摘要' 或会话标识
  model: string;
  ctxTokens?: number;     // 最新一轮的上下文总量（input+cacheRead+cacheCreation）
  needsCompact?: boolean; // 上下文超阈值，建议压缩
  active: boolean;        // 2 分钟内有事件
  ago: string;            // '刚刚' / '8 分钟前' / '10月13日'
  out10min: number;       // 近 10 分钟输出 tokens
  rateTokS: number;       // 近 60s 输出速率
  spark: number[];        // 近 10 个 60s 桶的输出速率
}

export interface LiveData {
  currentTokS: number;    // 近 60s 输出速率
  peakTokS: number;       // 近 60 分钟 20s 桶峰值
  peakAt: string;         // 'HH:MM'
  ctxPerMin: number;      // 近 1 分钟读入（含缓存）
  callsPerMin: number;    // 近 1 分钟调用数
  activeCount: number;
  idleCount: number;
  buckets30: number[];    // 近 30 分钟，20s/桶，tok/s
  buckets60: number[];    // 近 60 分钟，20s/桶，tok/s
  sessions: LiveSession[]; // 活跃在前，最多 5 条
}

export interface SavingsCard {
  kind: 'warn' | 'info' | 'pos';
  icon: 'retry' | 'route' | 'cache';
  title: string;
  desc: string;
  amount: string;         // '−¥2.18' / '约省 ¥74/月' / '¥6.8/周'
}

export interface AdapterChip {
  name: string;
  status: 'on' | 'part' | 'off' | 'sub';
  hint?: string;
}

export interface AdapterTier {
  key: 'local' | 'cloud' | 'detect' | 'sub';
  label: string;          // '一档 · 本地日志直读'
  count: string;          // '4 · 全量 token + 模型'
  chips: AdapterChip[];
}

export interface SettingsModel {
  name: string;
  inputCny: number;
  outputCny: number;
  cacheReadCny: number;
}

export interface SettingsData {
  autoCompact?: { enabled: boolean; thresholdTokens?: number; applyClaudeCode?: boolean; installRtk?: boolean };
  rtkInstalled?: boolean;
  /** 'ours' = 本工具装的 rtk-oss；'foreign' = 其他来源的 rtk；'none' = 未安装 */
  rtkSource?: 'ours' | 'foreign' | 'none';
  /** 人话说明，前端直接展示 */
  rtkDetail?: string;
  models: SettingsModel[];
  overrideNames: string[];   // 当前被人工覆写的模型名（弹窗 diff 保存用）
  cloudApis: { name: string; monthlyCny: number }[];
  subscriptions: { name: string; monthlyCny: number }[];
  monthlyBudgetCny: number | null;
  usdToCny: number;
}

export interface CompressionData {
  potentialCny: number;        // 本月若压缩可省（保守口径）
  potentialCnyMax: number;     // 上限口径
  itemCount: number;
  patterns: { stale: number; reread: number; long: number };  // CNY
  sessions: { key: string; agent: string; wasteCny: number; items: number; topPatterns: string[] }[];
}

export interface TrendSplit {
  cacheReadCny: number;
  cacheWriteCny: number;
  outputCny: number;
  newInputCny: number;
}

export interface MixSet { model: MixRow[]; tool: MixRow[]; proj: MixRow[] }

export interface DashboardData {
  /**
   * 生成这份数据的 token-pilot 版本（取自 package.json）。
   * 让用户在看板/面板上直接看到自己装的是哪一版，方便判断自动更新是否生效。
   * 可选：老数据文件没有这个字段，前端回退到 app 自带版本或干脆不显示。
   */
  appVersion?: string;
  generatedAt: number;    // unix ms
  usdToCny: number;
  dateLabel: string;      // '10月20日 周二'
  trayTitle: string;      // '¥47.62 · 86%'

  hero: { today: HeroPeriod; week: HeroPeriod; month: HeroPeriod };

  budget: {
    monthlyCny: number;
    spentCny: number;       // 含固定费
    remainingCny: number;
    pct: number;            // 0-100+
    dailyCny: number;       // 预算日均
    forecastCny: number;    // 月底预计（含固定费）
  } | null;

  cacheStrip: { savedCny: number; hitRate: number } | null;  // 本月缓存省钱

  live: LiveData;

  stats: {
    tokens: StatCard; output: StatCard; cacheRead: StatCard; cacheWrite: StatCard;
    newInput: StatCard; hitRate: StatCard; speed: StatCard; calls: StatCard;
  };

  trend: {
    days: DayPoint[];       // 28 天
    budgetDailyCny: number | null;
    todaySplit: TrendSplit;
    sum14Cny: number;
    peakCny: number;
  };

  mix: { today: MixSet; week: MixSet; month: MixSet };

  tokTrend: { days: DayPoint[]; top: { model: string; tool: string; proj: string } };

  modelRank: RankRow[];   // 今日，最多 5
  hostRank: RankRow[];    // 今日，最多 6

  savings: SavingsCard[]; // 最多 3
  compression: CompressionData | null;  // 压缩潜力（2A）

  adapters: AdapterTier[];

  /**
   * 订阅额度与余额。
   * 可选：拉取失败或用户没有任何可监控平台时为 null，账单功能完全不受影响。
   */
  quota?: QuotaSnapshot | null;

  settings: SettingsData;
}
