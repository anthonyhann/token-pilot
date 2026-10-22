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
  sessionTitle?: string;    // 会话首条用户消息摘要（可选，用于实时会话行）
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

// 内容流事件 —— 只记尺寸，不落内容（少采集红线）
// 用于压缩潜力检测：tool 输出的体积与存活轮数
export interface ContentEvent {
  agent: string;
  sessionId: string;
  timestamp: number;        // unix ms
  kind: 'tool_use' | 'tool_result';
  tool?: string;            // 'Read' | 'Bash' | ...
  targetPath?: string;      // 读取/操作的文件路径（重复读取检测用）
  sizeBytes: number;        // 内容的 JSON 序列化尺寸
}
