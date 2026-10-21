# token-pilot

> **你所有 AI 工具的本地账单 + 预算控制器。**
> 只读本地日志，零入侵，数据不出本机。

我同时用 Claude Code、Codex、Kimi Code，还经常通过它们跑 DeepSeek、GLM 等国产模型。有一天我发现：**我根本答不上来"我这个月给 AI 烧了多少钱"。** 每个工具有自己的用量页，分散、单位不一、没有总账，更没有预算。

所以有了 token-pilot。

```bash
$ token-pilot today

token-pilot · 今天

按宿主：
  claude-code       12.85M tokens     $6.41      248 次
  kimi-code         ...

合计：12.85M tokens · $6.41 · 248 次调用
```

> 数字准到什么程度？仓库自带独立对账脚本 `scripts/reconcile.py`（不复用采集代码、第三方视角重算原始日志），月/日 tokens 与调用数逐项相等。

## 它能做什么

- **本地账单**：一条命令看清今天/本月各工具、各模型烧了多少 token、多少钱
- **本地看板**：`token-pilot serve` 起本地看板（花费趋势、构成环图、实时流速、活跃会话、省钱建议、适配器状态），10 秒自刷新，数据不出本机
- **预算控制**：设月度预算，快超了系统通知弹你
- **打转检测**：揪出"死循环/反复重试"的会话——那些被 Agent 白烧钱还不出活的坑
- **省钱建议**：识别"贵模型干轻活"、低缓存命中的会话，告诉你每月/每周能省多少
- **菜单栏**：macOS + Windows 状态栏常驻，今日金额+预算进度一抬头就看到；左键点图标弹出本地面板（失焦自动收起），面板里一键打开完整看板，右键出菜单

## 快速开始

```bash
npm install -g token-pilot    # 或 npx token-pilot today

token-pilot today             # 今天的账单
token-pilot month             # 本月 + 月底预测 + 打转检测 + 省钱建议
token-pilot report            # 完整报告
token-pilot serve             # 本地看板 http://127.0.0.1:17895（实时刷新，可选）
token-pilot dash              # 生成静态看板 ~/.token-pilot/dashboard.html
token-pilot sync              # 只刷新数据文件（增量缓存，热跑 <1s）
```

### 状态栏应用（macOS / Windows）

```bash
cd menubar
npm install
npx tauri build        # 产出 .app / .msi 安装包
```

安装启动后**只在状态栏显示一个图标**（无 Dock 图标、无启动窗口）：
- 左键图标 → 本地面板在图标下方弹出，点别处自动收起
- 面板底部「打开完整看板」→ 原生看板窗口（自带数据，不需要 serve）
- 右键图标 → 菜单（打开面板 / 打开看板 / 退出）
- 数据每 60s 自动刷新（磁盘增量缓存 + 单飞锁，不会堆积拖慢机器）

> 芯片说明：macOS 在 Apple Silicon 上构建即 arm64 原生；要兼容 Intel Mac 用 `--target universal-apple-darwin`；Windows 出 x64 .msi（建议 GitHub Actions 交叉构建）。

设预算（超了会弹系统通知）：

```bash
mkdir -p ~/.token-pilot
echo '{"monthlyBudgetCny": 1500}' > ~/.token-pilot/config.json
```

也可以在看板右上角「数据设置」里直接改：模型单价、云端 API 月费、订阅月费、月度预算。

## 支持的工具

token-pilot 按"数据深度"分档覆盖，**不假装都能读**：

| 档 | 工具 | 数据深度 |
|---|---|---|
| 本地日志直读 | Claude Code / Codex / Kimi Code / pi | 全量 token + 模型 |
| 本地 SQLite 直读 | OpenCode / Cursor | token |
| 国产模型归一 | DeepSeek / GLM / Kimi / Qwen / MiniMax / 混元 / MiMo / LongCat / Doubao | 靠宿主日志的 model 字段 + 定价表 |
| 云端用量 API | Doubao(火山) / OpenAI API / Moonshot | 各厂 usage API |
| 仅检测 | Antigravity / Augment / CodeBuddy / Copilot / Kilo / Qwen Code / Trae / Windsurf / ZCode / Hermes / Cline | 检测到已安装，但该工具不写本地用量日志 |
| 桌面端（订阅制） | Kimi.app / ChatGPT.app 等 | 记固定订阅成本（它们不按 token 计费） |

**国产模型不用单独配置**——你用 Claude Code / Kimi Code 跑 DeepSeek、GLM，用量已经在宿主日志里，token-pilot 按 model 归一自动算。

## 设计原则

- **少采集**：只读本地日志，不注入 hook、不改你的配置；流式快照按 message.id 去重，缓存 token 不重复计费
- **快计算**：本地解析，秒出结果；增量采集（mtime 快跳）
- **低成本**：零依赖、零后台常驻（除非你开菜单栏/serve）
- **本地化**：数据不出本机，没有任何遥测上传
- **能提醒**：预算快超了系统通知
- **能节流**：打转检测 + 省钱建议，帮你不被 Agent 白烧
- **可验证**：`python3 scripts/reconcile.py` 独立重算原始日志，与 CLI 输出逐项对账

## 技术说明

- 采集层：声明式 adapter（一个工具一个文件），读本地 jsonl/SQLite
- 成本层：`pricing/models.json` 定价表（含国产模型 cacheRead 目录价），接受社区 PR 修正
- 归一层：schema 对齐 LoongSuite Pilot 的 `gen_ai.usage.*` 语义约定（它预留了 cost 字段没填，我们填上）
- 看板层：`src/core/contract.ts` 定义 DashboardData 契约 → `aggregate.ts` 单遍聚合 → `serve`（localhost HTTP，设置弹窗可写回配置）或 `dash`（静态 bake）两种形态；web/dashboard.html 与 web/panel.html 共用一份契约
- 菜单栏：Tauri（Rust 壳 + TrayIcon + 面板窗口），macOS/Windows 同码，60s 自动刷新托盘标题

> 参考蓝本：[alibaba/loongsuite-pilot](https://github.com/alibaba/loongsuite-pilot)（架构思想）、[ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)（只读日志路线）。token-pilot works standalone, supercharges with LoongSuite Pilot.

## 加一个新工具

见 [docs/adding-an-adapter.md](docs/adding-an-adapter.md)。一个 adapter 一个文件，社区可直接 PR。

## License

MIT
