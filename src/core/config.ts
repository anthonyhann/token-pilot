// 配置加载 — ~/.token-pilot/config.json，环境变量优先

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface TokenPilotConfig {
  monthlyBudgetUsd?: number;   // 月度预算（美元）
  usdToCny?: number;           // 汇率
  alertOnPercent?: number;     // 超过预算百分之多少就告警（默认 80）
}

const CONFIG_PATH = path.join(os.homedir(), '.token-pilot', 'config.json');

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
