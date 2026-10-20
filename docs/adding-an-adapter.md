# 加一个新工具（Adapter）指南

token-pilot 的采集层是**声明式 adapter**：加一个新宿主 = 加一个文件 + 注册一行，不改核心。

## 三步加一个新宿主

### 1. 新建 `src/adapters/<your-tool>.ts`

实现 `Adapter` 接口（见 `src/adapters/types.ts`）：

```typescript
import type { Adapter } from './types.ts';
import type { UsageEvent } from '../core/schema.ts';

export const yourToolAdapter: Adapter = {
  meta: {
    id: 'your-tool',                    // 唯一 id
    displayName: 'Your Tool',           // 显示名
    detectPaths: ['~/.your-tool'],      // 检测路径
    detectCommands: ['your-tool'],      // 检测命令
  },

  async detect() {
    // 返回本机是否装了该宿主（通常是检查目录存在）
  },

  async readEvents(sinceMs: number): Promise<UsageEvent[]> {
    // 读该宿主的本地日志，返回 UsageEvent[]
    // sinceMs 之前的可以跳过（用文件 mtime 快速过滤，快计算）
  },
};
```

### 2. 在 `src/cli/index.ts` 注册

```typescript
import { yourToolAdapter } from '../adapters/your-tool.ts';
const ALL_ADAPTERS = [claudeCodeAdapter, codexAdapter, kimiCodeAdapter, yourToolAdapter];
```

### 3. 如果是新模型，在 `pricing/models.json` 加定价

```json
"your-model-name": { "provider": "...", "input": 0.30, "output": 1.20 }
```

## UsageEvent 字段约定

对齐 LoongSuite Pilot 的 `gen_ai.usage.*` 语义约定：

| 字段 | 说明 |
|---|---|
| `agent` | 宿主 id，如 `claude-code` |
| `sessionId` | 会话 id（用于打转检测） |
| `timestamp` | unix ms |
| `provider` | `anthropic` / `deepseek` / `glm` / `kimi` ... |
| `model` | 模型名（定价靠它） |
| `usage.inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens / totalTokens` | token 明细 |

## 数据深度分级（诚实原则）

- 有全量 token+model → 一档
- 只有会话数/消息数 → 标注"仅会话"
- 没有本地用量日志 → 标"仅检测"，不要硬采

**不要为了让数字好看而编造 token 数。** 读不到就如实标注。

## 验证

```bash
token-pilot today    # 看你的宿主是否出现、数字是否合理
```
