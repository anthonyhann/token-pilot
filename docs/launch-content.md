# token-pilot 首发内容稿

## 一、X 帖（认识我，发布日发）

**主推文：**

> I run Claude Code with DeepSeek, GLM, and Claude models all day.
>
> Last week I realized I had no idea what I was actually spending.
>
> So I built token-pilot — a local bill for all your AI tools.
>
> One command. Real dollars. Reads local logs only, nothing leaves your machine.
>
> Menubar app for macOS + Windows.
>
> 🧵 how I built it 👇

**线程（拆开讲）：**

1/ Last month my AI bill was $372. I found out by building the tool to measure it. Nobody tracks the Chinese models — DeepSeek, GLM, Kimi. token-pilot does.

2/ It reads local logs only. No hooks, no config changes, no proxy. Zero intrusion. If a tool doesn't log usage locally, token-pilot says so honestly instead of guessing.

3/ It caught a runaway session burning $36 on retries. And told me I could save $20/mo by not using Claude Sonnet for trivial tasks. This is the "节流" part.

4/ Open source, MIT. Pricing table includes Chinese models. PRs welcome — especially model pricing corrections.

---

## 二、YouTube / B站（看我做到，用第 1 周录屏剪）

**标题**：《我同时用 Claude/DeepSeek/GLM/Kimi，一个月烧了多少钱？我造了个工具算清楚》

**结构（5-8 分钟）**：

| 段 | 时长 | 内容 |
|---|---|---|
| 钩子 | 0:00-0:30 | 直接亮数字：「上个月我的 AI 账单是 $372，我赌你也不知道你的」 |
| 问题 | 0:30-1:30 | 每个工具有自己的用量页，分散、单位不一、没总账、没预算；国产模型更没人算 |
| Build | 1:30-5:00 | 读日志 → 定价表 → 预算 → 告警 → 打转检测 → 菜单栏（录屏快进+卡点解说） |
| 结果 | 5:00-6:00 | 真实账单展示；「我抓到个 $36 打转会话」；「换模型能省 $20/月」 |
| 收尾 | 6:00-6:30 | 开源了，GitHub 在简介；第 2 版加 token 压缩，关注看后续 |

**关键镜头**：`token-pilot month` 一次跑出全账单的那一瞬间。

---

## 三、小红书（认识我，图文 5 卡）

**封面标题**：《Claude+DeepSeek+GLM 混着用，一个月烧了多少钱？》

| 卡 | 内容 |
|---|---|
| 1 封面 | 「我的 AI 账单：$372/月」大字 + 看板截图 |
| 2 痛点 | 工具太多，每个都单独算，国产模型没人管，没有总账没有预算 |
| 3 方案 | 本地读日志、零入侵、国产模型自动归一、菜单栏常驻 |
| 4 结果 | 打转检测抓到 $36 死循环 + 省钱建议 $20/月 |
| 5 收尾 | 开源了，GitHub 搜 token-pilot；评论区告诉我你一个月烧多少 |

---

## 四、demo 录制脚本（60s）

```
0:00  终端打开，敲 token-pilot today
0:10  数字跳出来（今日 $5.64）
0:20  敲 token-pilot month，全账单滚动
0:35  停在"月底预计 $577"和打转检测的 $36
0:45  菜单栏图标特写：今日金额常驻
0:55  GitHub 仓库页，"开源，MIT"
```

---

## 五、发布顺序（对齐画像首发流程）

1. D7：GitHub 建仓 push + X 发突发奇想帖
2. 第 2 周：YouTube/B站 视频（用第 1 周录屏）
3. 第 2 周：小红书图文
4. 观察数据，回填画像 memory.md
