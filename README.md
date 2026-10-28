<div align="center">

<img src="docs/assets/icon.png" width="96" alt="token-pilot —— 所有 AI 工具的本地账单，本月实测 ¥7,328 / 38 亿 tokens">

# token-pilot ⚡

### 所有 AI 工具的本地账单，一抬头就看见

同时用 Claude Code / Codex / Kimi Code 跑国产模型的人，终于能答上「这个月给 AI 烧了多少钱」——只读本地日志，数据不出本机。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](#-状态栏应用)
[![Tests](https://img.shields.io/badge/tests-42%20passing-brightgreen)](tests/)
[![Accuracy](https://img.shields.io/badge/对账脚本-逐项一致-blue)](#-数据准确性)

[快速开始](#-快速开始) · [状态栏应用](#-状态栏应用) · [数据准确性](#-数据准确性) · [什么时候别用它](#-什么时候别用它) · [讨论](https://github.com/anthonyhann/token-pilot/discussions) · [贡献](CONTRIBUTING.md) · [English](README-en.md)

</div>

---

![状态栏面板](docs/assets/menubar-panel.png)

> 状态栏常驻 `⚡ ¥今日 · 预算%`。左键弹面板，「打开完整看板」看全部。我的真实 10 月：**38.1 亿 tokens · ¥7,328 · 27,450 次调用**（[怎么算的](#-数据准确性)）。

> ⚠️ npm 上另有一个**别人家的** `token-pilot`（MCP 代码导航工具，会往 Claude Code 写 hooks）。我们的包是 **`@anthonyhan/token-pilot`**，下面命令都带 scope，照抄即可。

## 🚀 快速开始

**For Humans：**

```bash
npm install -g @anthonyhan/token-pilot
token-pilot month     # 本月账单 + 月底预测 + 打转检测 + 省钱建议
```

**For AI Agents：**（把这句粘贴给你的 Agent）

> 帮我安装 token-pilot：`npm install -g @anthonyhan/token-pilot`，然后跑 `token-pilot month` 告诉我这个月 AI 花了多少钱、哪里在浪费。

### 状态栏应用

安装启动后**只在状态栏显示一个闪电图标**——无 Dock 图标、无启动窗口；左键弹面板，右键出菜单。

**macOS（Apple Silicon / Intel）**：

```bash
# 方式一：Homebrew（推荐，自动处理 Gatekeeper，装完即用）
brew install --cask anthonyhann/token-pilot/token-pilot
```

```bash
# 方式二：Releases 手动下载 .dmg，拖入「应用程序」后跑一次（解决未签名的「已损坏」误报）
xattr -dr com.apple.quarantine /Applications/token-pilot.app
```

**Windows**：Releases 下载 `.msi`，SmartScreen 选「仍要运行」。

> 长期解：Apple 开发者签名+公证（$99/年）在 TODO 里，有赞助再开。

自己构建：`cd menubar && npm install && npx tauri build`

## 🎯 为什么做这个

我同时用 Claude Code、Codex 和 Kimi Code 跑国产模型，账单散在三个地方：Claude 记一笔、Codex 记一笔、Kimi 记一笔，没有一个地方能回答「这个月总共烧了多少」。

试过几个现有方案，都不合用：

| 方案 | 国产模型 | 只读本地 | 状态栏 | 卡在哪 |
|---|---|---|---|---|
| ccusage | 部分 | ✅ | ❌ | 以 Claude Code 为主，`deepseek-v4.1-flash` 这类模型的归一路径不全 |
| 各工具自带用量页 | ✅ | — | ❌ | 每个工具各看各的，没法合并成一张账单 |
| 商业账单 / 代理类工具 | ❌ | ❌ | ✅ | 要把日志或请求过一遍云端，我不放心把完整会话历史交出去 |
| **token-pilot** | **9 家** | **✅** | **✅** | — |

核心区别只有一句：**它把国产模型和海外模型放在同一张账单里，而且全程不出本机。**

## ✨ 功能清单：它能做什么

| 场景 | 你说 | 它做 |
|---|---|---|
| 看账单 | `token-pilot month` | 按宿主/按模型双维度月账单 + 月底预测 |
| 怕超支 | 设个月度预算 | 进度条 + 超支系统通知 + 托盘常驻 `¥今日 · 预算%` |
| Agent 打转 | 不用说话 | 自动揪出「单会话 ≥30 次调用」的死循环，算出浪费金额 |
| 想省钱 | 看「省钱建议」卡 | 贵模型干轻活 → 迁移建议+每月省多少；低缓存命中 → 优化空间；本月缓存帮你省了多少 |
| 上下文太长 | 自动提醒 / 点徽标 | 会话超 100K 上下文标记「该压缩」，可写 Claude Code autoCompact / 装 RTK 输出压缩层（含压缩引擎，装完自动 `rtk init -g` 接入 Claude Code hook） |
| 想知道能省多少 | 看「压缩潜力」板块 | 本月陈旧输出/重复读取/超长输出各浪费多少钱，按模式拆分 + 列出最浪费的 5 个会话 |
| 核对价格 | `token-pilot prices` | 每个在用模型的单价来源（目录价/人工覆写/自动补价待核对） |
| 谁在烧 | 看「宿主/模型/项目榜」 | 哪个工具、哪个模型、哪个项目花最多，一目了然 |
| 国产模型 | 不用配置 | DeepSeek/GLM/Kimi/Qwen 走宿主日志 model 字段自动归一 |

**兼容你的工具链：** Claude Code ✅ · Codex ✅ · Kimi Code ✅ · OpenCode ✅（全量 token）· DeepSeek/GLM/Kimi/Qwen/MiniMax/混元/MiMo/LongCat/Doubao ✅（模型归一）· 其余 12 款仅检测 · 桌面订阅端记固定月费

## 📈 数据准确性

账单工具不准就是误导。所以准确性**可验证**：

```bash
python3 scripts/reconcile.py month    # 第三方视角独立重算原始日志，与 CLI 逐项对账
python3 scripts/verify-dashboard.py   # 看板 36 项算法不变量校验
npm test                              # 49 个单元测试（定价/采集口径/聚合/注入/熔断/RTK）
```

实测修过的口径坑（2026-10-21，本机 4787 个日志文件）：

| 坑 | 影响 | 修复 |
|---|---|---|
| Claude 流式快照重复行 | 某会话 169 行 usage 实为 79 次调用 | 按 `message.id` 去重取最大 |
| Codex `input` 含 `cached` 子集 | 缓存被按全价+缓存价计两次 | 拆分 `input − cached` |
| Kimi `inputOther` 才是新输入 | 同上 | 只认 `usage.record` 且不并入缓存 |

## 📊 凭什么信我

- 我自己的 AI 账单就是它管的：本月 **¥7,328 / 38.1 亿 tokens**（2026-10-27 本机实时数据）
- 36 项看板算法不变量 + 49 个单测 + 独立对账脚本，全部开箱可跑
- 诚实披露速率口径：日志按「调用完成时刻」记账，生成中的调用完成前不计入（看板内有注明）

## ⚠️ 什么时候别用它

- **你想管的工具不写本地用量日志**（Antigravity / Copilot / Cursor 等 12 款）——只能检测到装没装，读不到 token
- **桌面订阅 App**（Kimi.app / ChatGPT.app）——不按 token 计费，只能登记固定月费
- **想拦在请求前面节流**——它是事后分析，不拦截请求（拦截需要代理层，在 Roadmap）

## 💬 参与讨论

- **[Discussions](https://github.com/anthonyhann/token-pilot/discussions)** ——「这个模型算得对不对」「能不能支持某某工具」这类问题放这里，比开 issue 合适
- **[Issues](https://github.com/anthonyhann/token-pilot/issues/new/choose)** ——数据算错、功能异常

## 💰 支持这个项目

token-pilot 免费且 MIT。如果它帮你省下了 AI 账单，可以请我喝杯咖啡：

| 支付宝 | 微信 |
|---|---|
| <img src="docs/assets/sponsor-alipay.png" width="260" alt="支付宝赞赏码"> | <img src="docs/assets/sponsor-wechat.png" width="260" alt="微信赞赏码"> |

也想出现在这里？→ [bmomhan@gmail.com](mailto:bmomhan@gmail.com)（赞助位招租）

⭐ Star 本仓库 = 告诉我你在用哪个宿主——下一个 adapter 优先做 Star 用户提名最多的那个。

## 🙋 关于我

一个人 + 几个 AI Agent 在做产品实验（西安远程）。token-pilot 是我自己每天真在用的工具——它先抓出了我 kimi-code 里一个打了 120 次调用的打转会话，又告诉我这个月缓存帮我省了 ¥3,048。

**保持联系：** [X @AnthonyHan_](https://x.com/AnthonyHan_) · [bmomhan@gmail.com](mailto:bmomhan@gmail.com)

## 📝 更新日志

完整分版本说明见 [RELEASE_NOTES.md](RELEASE_NOTES.md)（也是客户端自动更新弹窗的文案来源）。

- **v0.3.2** RTK 改用含压缩引擎的完整版，装完自动接 hook（备份/回滚保护）；新增发布数据回流脚本
- **v0.3.1** npm 包缺 web 目录修复、看板前端编入 app 二进制
- **v0.3.0** 新增「压缩潜力」板块，修省钱建议卡被静默丢弃
- **v0.2.9** 自动发布链路修复（三平台产物上传与命名）
- **v0.2.6** 激活自动更新链路 + 打转熔断主动通知（含防轰炸）
- **v0.2.5** npm scope 校正为 `@anthonyhann`，包可运行性修复
- **v0.2.3** 2B 压缩执行第一层（自动压缩 + autoCompact 写入 + RTK）、价格核对台
- **v0.2.1** 定价表对齐 8 家官方目录价、DeepSeek 分时、面板布局修复
- **v0.2.0** 压缩潜力量化、9 源采集覆盖、三处口径修复
- **v0.1.0** 首版 → CLI 账单 + 本地看板 + macOS/Windows 状态栏应用，三形态一次给齐

## ✅ TODO LIST

**采集覆盖**
- [x] OpenCode adapter（SQLite）
- [x] Qoder adapter（仅会话数，model 全为 auto——诚实标注）
- [x] pi adapter
- [x] Cursor spike（结论：无 token 用量数据，ai-code-tracking 是代码追踪非用量 → 诚实归「仅检测」）
- [x] 云端用量 API：Doubao 火山（arkcli usage stats，日粒度）
- [ ] 云端用量 API：OpenAI / Kimi 开放平台（需用户配 API key）

**节流（Step 2）**
- [x] 2A 压缩潜力量化（规则引擎：陈旧输出/重复读取/超长输出 → 本月可省多少，实测 $63-95）
- [x] 2B 压缩执行第一层：自动压缩提醒 + Claude autoCompact 写入 + RTK 安装（含 engine 的完整版；自动接 hook，改动 settings.json 前备份、失败还原）
- [x] 异常重试自动熔断提醒（`breaker.ts`：单会话 ≥30 次调用即主动通知，每轮最多提 1 个防首跑轰炸）
- [ ] 2B 压缩执行第二层：代理网关（LiteLLM/自研，视数据再定）
- [ ] 低价模型路由（本地代理层，可选开启，默认不动你任何配置）

**平台与工程**
- [x] macOS 状态栏应用（arm64 + Intel x64 双架构 .app/.dmg）
- [x] Windows 核查 + 分平台图标 + CI（`.msi` 由 Actions 产出）
- [x] 自动更新（tauri-updater，v0.2.6 起生效，三平台共用一份 `latest.json`）
- [x] CI 自动发布：打 tag 后三平台产物 + 合并版 `latest.json` 自动进 Release，并回写 brew cask
- [ ] Windows `.msi` 实机安装验证（目前只验证到 Actions 产物层）
- [ ] 统一二进制（universal2 单包替代 arm64/x64 两个 dmg）
- [ ] 签名与公证（Apple Developer $99/年，有赞助再开）

## English

**[README in English → README-en.md](README-en.md)**

*token-pilot* — local billing + budget control for all your AI coding tools. Reads local logs only (no hooks, no telemetry). CLI + local dashboard + menubar app (macOS/Windows). Chinese models (DeepSeek/GLM/Kimi…) auto-normalized via host-log `model` field.

## License

[MIT](LICENSE) © anthonyhann
