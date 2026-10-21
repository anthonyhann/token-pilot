# token-pilot 交付总结

> 版本：v0.1.0 · 日期：2026-10-21 · 仓库：/Users/hanqiang/www/ai/token-pilot（10 commits）

## 一句话

**你所有 AI 工具的本地账单 + 预算控制器**：只读本地日志、零入侵、数据不出本机；CLI + 本地看板 + macOS/Windows 状态栏应用三形态。

## 交付清单

### 1. 采集层（准确性优先，独立对账可证明）

| Adapter | 数据源 | 口径 |
|---|---|---|
| claude-code | `~/.claude/projects/**/*.jsonl` | 按 `message.id` 去重取最大快照（流式重复行实测 169→79/会话） |
| codex | `~/.codex/sessions/**/*.jsonl` | `token_usage_record`；`input − cached` 拆开（cached 是子集，实测验证） |
| kimi-code | `~/.kimi-code/sessions/**/wire.jsonl` | 只认 `usage.record`；`inputOther` 才是新输入（缓存不重复计费） |

- **准确性验证**：`scripts/reconcile.py` 独立重算（不复用采集代码、不按 mtime 跳文件），月/日 tokens 与调用数与 CLI **逐项相等**（claude 776,149,515 tokens / 12,189 次完全一致）
- 修复前 → 后：月调用 25,016 → 12,380 次（去重），月成本 $372.60 → $319.89（缓存口径）
- 增量缓存 `events-cache.json`（文件 mtime 级）：热缓存 sync **0.49s**（冷 4.9s，10×）；单飞锁 `sync.lock`（120s TTL，CLI/serve/菜单栏三处共用）

### 2. 成本与预算层

- 定价表 `pricing/models.json`：21 个模型含 cacheRead 目录价（DeepSeek 命中 25%、GLM/Kimi 10% 档）；`priceFor` 精确→大小写归一→前缀→fallback
- 配置 `~/.token-pilot/config.json`：CNY 预算、汇率、价格覆写（¥/M）、云端 API 月费、订阅月费；看板设置弹窗可直接写回
- 预算引擎：月度预算 + 进度 + 超支系统通知（跨 10% 档位触发一次）；固定费计入月度口径
- 打转检测：单会话 ≥30 次调用且 ≥$0.3 → 告警，浪费 = 超头部分成本
- 省钱建议：贵模型干轻活迁移建议（$/月）、低命中会话缓存优化空间（¥/周）、缓存省钱条（本月缓存省了多少）

### 3. 聚合层（DashboardData 契约）

`src/core/contract.ts` 定义契约，`aggregate.ts` 单遍扫描产出全部模块数据：

- 三周期 Hero（今日/本周/本月：花费/tokens/输出/调用/命中率/活跃宿主 + 4 pills 联动）
- 实时流速（30/60 分钟 20s 桶）+ 活跃会话（路径/标题/模型/10 分钟输出/sparkline/速率）
- 8 张统计卡（今日 Tokens/输出/缓存读/缓存写/新输入/命中率/速率中位·P90/调用，各带 14 天 mini 序列）
- 28 天趋势（花费/Token/调用三模式 + 预算日均线 + 今日成本四分项页脚）
- 构成环图与 Token 曲线（模型/工具/项目三维度 × 三周期）
- 模型/宿主排行榜（分档标签）+ 适配器状态（25 源 6 档实时检测）

### 4. 前端（原型 1:1 落地）

- `web/dashboard.html`：完整看板。CSS 与原型**字节级一致**；16 个模块全真数据；深浅色/周期 seg/构成 seg/弹窗/tooltip pin/Esc 全交互保留；Playwright 实测 0 JS 错误
- `web/panel.html`：菜单栏面板。11 个模块全真数据
- 数据加载三态：静态注入（`__TP_DATA__`）→ Tauri invoke → `/api/data` 轮询

### 5. 本地服务（可选）

`token-pilot serve`（127.0.0.1:17895）：看板 + 面板预览 + `/api/data` + `/api/config` 读写；10s 增量刷新、30min 全量（带锁）；预算告警。

### 6. 状态栏应用（Tauri 2，macOS + Windows）

逆向 CatPaw Pilot（loongsuite-pilot）Swift 实现并移植：

- **Accessory 模式**：无 Dock 图标、无启动窗口，纯状态栏驻留（实测验证）
- 左键托盘图标 → 面板弹在图标正下方（边界修正、底栏自动翻转），失焦自动收起
- 右键 → 菜单（打开面板 / 打开看板 / 退出）
- 看板为**原生窗口**（1320×900，可拖拽调大小，min 1040×640），内置数据不需要 serve
- 设置弹窗在应用内写回 config.json（保存即触发 sync 重算）
- 托盘标题 = `¥今日花费 · 预算%`，每 20s 自刷（sync 有锁 + 热缓存 <1s，不堆积）
- 图标：借 CatPaw 雷达风重绘——深底圆角方 + 品牌橙红渐变雷达环 + 中心闪电；状态栏为单色模板闪电（macOS 深浅菜单栏自适应）

**产物**（`menubar/src-tauri/target/release/bundle/`）：
- `macos/token-pilot.app`（11.87MB，arm64 原生，实测启动/无 Dock/数据渲染正常）
- `dmg/token-pilot_0.1.0_aarch64.dmg`（3.25MB）

> 未签名：首次打开需右键 → 打开。分发 Intel Mac 用 `--target universal-apple-darwin`；Windows .msi 建议 GitHub Actions 交叉构建（`x86_64-pc-windows-msvc`）。

## 两次事故与修复（诚实记录）

| 事故 | 根因 | 修复 |
|---|---|---|
| 系统卡死 | sync 全量扫 2GB/4787 文件 7s 满 CPU 且无防重入；菜单栏 60s 定时器叠加 spawn → 进程雪崩 | 磁盘增量缓存（10×）+ 单飞锁 + serve 降频共用锁 |
| tok/s 不准/滞后 | 日志 tokens 全记在调用完成时刻，直接分桶 = 虚高尖峰 + 滞后 | 按 [同会话上一事件, 完成时刻] 匀速分摊（≤120s），总量不变；峰值 249.6→60.5 tok/s；看板注明口径 |

## 设计原则兑现

少采集（只读日志零 hook）· 快计算（增量缓存 <1s）· 低成本（零依赖零常驻）· 本地化（不出本机）· 能提醒（预算系统通知）· 能节流（打转/迁移/缓存三卡）· 可验证（独立对账脚本）

## 下一步

1. Windows 交叉构建（GitHub Actions）+ 发布 v0.1.0
2. 更多 adapter：opencode（SQLite）、qoder（会话数）、pi
3. Step 2：token 压缩与低价模型路由（代理层）
