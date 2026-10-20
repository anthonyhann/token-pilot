# token-pilot 前端对标 · 功能模块清单与开发路径

> 输入：`token-pilot-dashboard.html`（完整看板原型）、`token-pilot-menubar-panel.html`（菜单栏面板原型）
> 目标：前端功能/交互/样式 1:1 落地，全部接真实数据，数据采集准确无误。

## 一、原型提取的功能模块

### A. 完整看板（Dashboard）

| # | 模块 | 数据需求 | 交互 |
|---|------|---------|------|
| A1 | Hero 区：花费大字 + tokens + 输出/调用/命中率副行 + 4 个 pill（周期联动：近30天/本周/今日、日均、预算剩、月底预计） | 今日/本周/本月/30天聚合、预算、预测 | 今日/本周/本月 seg 切换，fade 动画，localStorage 持久化 |
| A2 | 实时流速：当前 tok/s、峰值+时间、读入上下文/分、调用/分、近30/60分钟 20s 桶柱状图 | 事件时间戳分桶、会话活跃判定 | 30/60 分钟 seg，柱子 hover tooltip |
| A3 | 活跃会话列表：项目路径+摘要、模型、10 分钟输出量、最后活跃、sparkline、tok/s | 按会话近 10 分钟聚合 | 静态展示 |
| A4 | 8 张统计卡：今日 Tokens（日均）、输出（含推理）、缓存读取（占读入%）、缓存写入、新输入、命中率（30天+今日）、输出速率（中位/P90）、模型调用（均次读入） | 分项聚合 + 速率分位数 + 14 天 mini 序列 | hover 浮起 |
| A5 | 花费趋势：28 天柱状、预算日均虚线、今日高亮 | 日序列 ×（花费/Token/调用） | 3 模式 seg；tooltip（日期+星期+三指标）；点击 pin；Esc 取消；页脚今日成本构成 |
| A6 | 花费构成环图：模型/工具/项目 + 图例 + 中心总额 | byModel / byAgent / byProject | seg 切换持久化；扇区+图例 hover tooltip |
| A7 | Token 趋势曲线：28 天平滑曲线+面积+末点 | 日 token 序列 | tooltip 含分维度主力占比 |
| A8 | 模型用量榜：名称、provider·调用·最后活跃、金额、占比、堆叠条、输出/命中/速率子行 | per-model 聚合 | 静态 |
| A9 | 宿主用量榜：同上 + 分档标签（一档/二档/无token） | per-host 聚合 + tier 元数据 | 静态 |
| A10 | 省钱建议 3 卡：打转检测（浪费）、模型迁移（省/月）、缓存优化空间（/周） | retry waste、route advice、低命中会话 | 静态 |
| A11 | 适配器状态：6 档 25 源、状态点（on/part/off/sub）、计数 hint | 检测统计 | 筛选 chips（全部/本地/云端/仅检测/订阅） |
| A12 | 设置弹窗：模型单价（¥/M：输入/输出/缓存读）、云端 API 月费、订阅月费，增删行 | 配置读写 | 弹窗开关/Esc/点外关闭、行编辑、保存提示 |
| A13 | 缓存省钱条：本月缓存省 ¥x · 命中率 | cacheRead×(input−cacheRead 价) | 静态 |
| A14 | 顶栏：品牌+「本地运行·零采集」、日期、预算 pill、设置入口、深浅色切换 | 预算 | 主题持久化 |
| A15 | 托盘标题 mock：`¥今日 · 预算%` | — | — |

### B. 菜单栏面板（Menubar Panel）

| # | 模块 | 说明 |
|---|------|------|
| B1 | 面板头：logo/标题/「本地·零采集」徽标/日期/主题/关闭（关闭动画+重开按钮） | Tauri 窗口行为 |
| B2 | Hero：周期 seg（持久化）、实时速率 pill、花费、副行、预算条（剩/预计） | 同 A1 数据 |
| B3 | 缓存省钱条 | 同 A13 |
| B4 | 4 KPI 卡（随周期切换：峰值速率/输出/缓存读取/活跃宿主 → 周/月换指标） | 周期聚合 |
| B5 | 14 天花费柱状 + 预算日均线 + tooltip | 日序列 |
| B6 | 14 天 Token 曲线 + tooltip | 日序列 |
| B7 | 构成 mix（模型/工具/项目 seg，持久化） | 同 A6 |
| B8 | 实时会话行（sparkline+速率）+「另有 N 个空闲会话」 | 同 A3 |
| B9 | 省钱建议 3 行 | 同 A10 |
| B10 | 底部「打开完整看板」+ 本地运行说明 | Tauri shell.open |
| B11 | 托盘标题：`¥今日花费 · 预算%` | Rust 侧定时刷新 |

## 二、数据采集准确性审计（实测发现，必须先修）

| # | 问题 | 证据 | 影响 | 修法 |
|---|------|------|------|------|
| F1 | claude-code 无去重：同 message.id 流式快照多行（前 N 行全零，末行真实值） | 抽样会话 169 行 usage / 79 唯一 id | 调用数虚高 ~2× | 按 message.id 分组取 totalTokens 最大行；eventId=message.id |
| F2 | kimi-code 缓存重复计费：inputTokens=inputOther+cacheRead+cacheCreation，costOf 又对 cacheRead 计一次 | 代码走查 | 缓存按全价+缓存价计两次，成本高估 | inputTokens=inputOther；total=全部相加 |
| F3 | codex 缓存重复计费：input_tokens 含 cached_input_tokens（实测 total=input+output，cached 是子集） | rollout 实测 56369+956=57325 | 同上 | inputTokens=input−cached；cacheRead=cached |
| F4 | kimi adapter 未过滤 type，靠 model 字段侥幸排除 | 实测其他类型行 model=None | 脆弱 | 显式 type==='usage.record' |
| F5 | 定价表缺 cacheRead 目录价 | models.json | 缓存省钱算不准 | 每模型补 cacheRead（默认 input×0.1） |

## 三、开发路径（本轮迭代）

```
P0 准确性修复（F1-F5）          → adapters + pricing
P1 契约 contract.ts             → DashboardData 全字段定义
P2 聚合引擎 aggregate.ts        → 单遍扫描产出契约全量
P3 CLI：sync（写 dashboard-data.json）/ serve（本地HTTP+设置写回）/ dash（静态bake）
P4 Dashboard 集成（prototype CSS 1:1，mock script → 数据驱动渲染）
P5 Menubar panel 集成 + Tauri 数据通道（invoke/emit + 托盘标题）
P6 对账验证（聚合 vs 原始日志独立重算）+ 截图走查 + commit
```

## 四、关键设计决策

1. **货币**：内部 USD 计算；展示层 ×usdToCny（默认 7.2，config 可改）。设置弹窗的 ¥/M 单价存 `priceOverrides`（CNY），加载时换算。
2. **预算**：`monthlyBudgetCny` 进 config；固定费（云端API月费+订阅）计入本月总花费与预测，不计入今日。
3. **输出速率**：事件间时间差估算（dur≤0 或 >300s 丢弃），中位/P90；峰值取 20s 桶最大值。
4. **会话活跃**：2 分钟内有事件=输出中；10 分钟内=空闲显示；超时不进实时区。
5. **服务形态**：默认零进程——`token-pilot sync` 写 `~/.token-pilot/dashboard-data.json`；`token-pilot serve`（localhost:17895）提供实时刷新与设置写回；Tauri 面板读 JSON 文件 + 定时 sync。
6. **样式**：两个原型的 CSS 原样保留（byte-level），只把 mock 数据脚本替换为数据驱动渲染。
