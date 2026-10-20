// 预算引擎 — 月度预算 + 进度 + 超支判定 + 趋势预测

export interface BudgetConfig {
  monthlyUsd: number;      // 月度预算（美元）
  currency?: 'usd' | 'cny';
  usdToCny?: number;       // 汇率（默认 7.2）
}

export interface BudgetStatus {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  percent: number;          // 0-100+
  overspent: boolean;
  forecastMonthEndUsd: number;  // 照当前速度月底预计
  forecastOverspend: boolean;   // 预计是否超支
}

export function evalBudget(spentUsd: number, cfg: BudgetConfig, now = new Date()): BudgetStatus {
  const today = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const forecastMonthEndUsd = today > 0 ? (spentUsd / today) * daysInMonth : spentUsd;

  return {
    budgetUsd: cfg.monthlyUsd,
    spentUsd,
    remainingUsd: cfg.monthlyUsd - spentUsd,
    percent: cfg.monthlyUsd > 0 ? (spentUsd / cfg.monthlyUsd) * 100 : 0,
    overspent: spentUsd > cfg.monthlyUsd,
    forecastMonthEndUsd,
    forecastOverspend: forecastMonthEndUsd > cfg.monthlyUsd,
  };
}

// 预算进度条（文本版，给 CLI 用）
export function progressBar(percent: number, width = 20): string {
  const clamped = Math.min(percent, 100);
  const filled = Math.round((clamped / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const mark = percent > 100 ? ' ⚠️ 超支' : percent > 80 ? ' ⚠️ 接近上限' : '';
  return `${bar} ${percent.toFixed(0)}%${mark}`;
}
