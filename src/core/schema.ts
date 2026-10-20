// UsageEvent — 统一用量事件 schema，字段对齐 LoongSuite Pilot 的 gen_ai.usage.* 语义约定
// 参考：loongsuite-pilot src/types/events.ts（已预留 cost 字段，我们填上）

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface UsageCost {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheCreationUsd: number;
  totalUsd: number;
}

export interface UsageEvent {
  // 来源
  agent: string;            // 'claude-code' | 'codex' | 'kimi-code' | 'qoder' | ...
  agentVersion?: string;

  // 标识
  sessionId: string;
  turnId?: string;
  eventId: string;
  timestamp: number;        // unix ms

  // 模型
  provider: string;         // 'anthropic' | 'deepseek' | 'glm' | 'kimi' | ...
  model: string;            // 'claude-sonnet-4-6' | 'deepseek-v4.1-flash' | ...

  // 用量
  usage: UsageTokens;

  // 成本（成本层填，采集层不填）
  cost?: UsageCost;

  // 上下文
  workspace?: string;       // 项目路径（用于"哪个项目烧钱"）
}

// 一个宿主一天/一段时间的聚合
export interface UsageSummary {
  agent: string;
  date: string;             // YYYY-MM-DD
  models: Record<string, UsageTokens & { cost?: UsageCost }>;
  totalTokens: UsageTokens;
  totalCostUsd?: number;
  sessions: number;
}
