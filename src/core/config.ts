// 配置加载/保存 — ~/.token-pilot/config.json，环境变量优先

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PriceOverrideCny {
  input: number;    // ¥ / 1M tokens
  output: number;
  cacheRead?: number;
}

export interface FixedFee {
  name: string;
  monthlyCny: number;
}

export interface TokenPilotConfig {
  monthlyBudgetUsd?: number;    // 月度预算（美元，旧字段兼容）
  monthlyBudgetCny?: number;    // 月度预算（人民币，优先）
  usdToCny?: number;            // 汇率（默认 7.2）
  alertOnPercent?: number;      // 超过预算百分之多少就告警（默认 80）
  priceOverrides?: Record<string, PriceOverrideCny>;  // 设置弹窗的模型单价覆写（¥/M）
  cloudApis?: FixedFee[];       // 云端用量 API 固定月费
  subscriptions?: FixedFee[];   // 桌面端/会员订阅月费
  autoCompact?: {
    enabled: boolean;            // 自动压缩总开关（默认关）
    thresholdTokens?: number;    // 触发阈值（默认 100K）
    applyClaudeCode?: boolean;   // 是否写 Claude Code 的 autoCompactEnabled（改宿主配置，需用户明示）
    installRtk?: boolean;        // 是否安装 RTK 输出压缩层（用户勾选才装）
  };
}

// 状态目录：测试用 TOKEN_PILOT_HOME 隔离到临时目录，避免碰用户真实数据
export const CONFIG_DIR = process.env.TOKEN_PILOT_HOME
  ? path.resolve(process.env.TOKEN_PILOT_HOME)
  : path.join(os.homedir(), '.token-pilot');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const DATA_PATH = path.join(CONFIG_DIR, 'dashboard-data.json');

export function loadConfig(): TokenPilotConfig {
  // 环境变量优先
  if (process.env.TOKEN_PILOT_MONTHLY_BUDGET_USD) {
    return {
      monthlyBudgetUsd: Number(process.env.TOKEN_PILOT_MONTHLY_BUDGET_USD),
      usdToCny: Number(process.env.TOKEN_PILOT_USD_TO_CNY ?? 7.2),
      alertOnPercent: Number(process.env.TOKEN_PILOT_ALERT_ON_PERCENT ?? 80),
    };
  }
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

export function saveConfig(cfg: TokenPilotConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function fxRate(cfg: TokenPilotConfig): number {
  return cfg.usdToCny && cfg.usdToCny > 0 ? cfg.usdToCny : 7.2;
}

// 月度预算统一折算成 CNY；未设置返回 undefined
export function monthlyBudgetCny(cfg: TokenPilotConfig): number | undefined {
  if (cfg.monthlyBudgetCny && cfg.monthlyBudgetCny > 0) return cfg.monthlyBudgetCny;
  if (cfg.monthlyBudgetUsd && cfg.monthlyBudgetUsd > 0) return cfg.monthlyBudgetUsd * fxRate(cfg);
  return undefined;
}
