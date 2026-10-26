# Release Notes

本文件是客户端自动更新的**唯一说明来源**：CI 发布时按 `## v<版本>` 段落抽取内容，
写进 `latest.json` 的 `notes` 字段，用户在「发现新版本」弹窗里看到的就是这里。

**发版流程**：新版本前在这里加一段 `## v0.2.7`（倒序排列在最上面），再打 tag。
段落里不要出现「构建中」字样——CI 会把它当作未完成状态直接让发布失败。

推送顺序建议：先把带 notes 的提交推到 main，再打 tag，避免 Release 说明落后于 tag。

---

## v0.2.7

- 修 npm 包名：纠正为 `@anthonyhann/token-pilot`（此前误发成少一个 n 的 scope，照 README 安装会 404）
- 发版全自动化：打 tag 后三平台产物与合并版 `latest.json` 自动进 Release，brew cask 同步 bump，不再需要手工上传
- 发布前置校验：三平台必须齐全、四处版本号必须一致、说明文案不得残留占位，任一不满足即中止发布
- 打包资源一致性检查：看板/面板 HTML 与 `web/` 源不一致时 CI 直接失败，避免发出旧前端
- 测试隔离：单元测试改用临时目录，不再读写你本机真实的 `~/.token-pilot` 状态

## v0.2.6

- 激活自动更新链路：客户端可从 GitHub Releases 自助升级，不再需要手动下载
- 打转熔断改为主动通知（单会话 ≥30 次调用即提醒）
- 同一轮打转最多通知 1 个会话，其余只标记不重复打扰（修首次运行的历史轰炸）

## v0.2.5

- 尝试修正 npm scope（当时改成了少一个 n 的写法，实际从 v0.2.7 起才真正对齐 `@anthonyhann`）
- 包名冲突说明：npm 上的 `token-pilot` 是同名第三方包（会往 Claude Code 注入 hooks），务必装 scoped 版
- npm 包可运行性修复：`tsc` 构建 `dist`，`bin` 走编译产物，`tsx` 仅承担开发态

## v0.2.3

- 2B 压缩执行：自动压缩提醒 + Claude Code autoCompact 写入 + RTK 输出压缩层一键安装（用户显式勾选才动配置）
- 价格核对台 `token-pilot prices`：每个在用模型的单价来源可查
- CI 清理步骤强制 bash shell（Windows runner 默认 PowerShell 不认 `rm -rf`）

## v0.2.2

- CI 构建前清理旧 bundle 产物，防止缓存把旧版本号包装进 artifacts

## v0.2.1

- 设置面板顶栏/底栏固定，内容区独立滚动
- 定价表全面对齐 8 家官方目录价，支持 DeepSeek 分时定价
- 补充 Xiaomi MiMo、LongCat 官方定价；本地模型（`.gguf`/路径）零费用不计价
- 覆写可一键按官网价重置；弹窗 diff 保存，修「设为 0 后再次冻结」；分时归一化除零导致的 NaN

## v0.2.0

- 压缩潜力量化（规则引擎）：陈旧输出 / 重复读取 / 超长输出 → 算出本月可省多少
- 9 源采集覆盖对齐，云端用量 API（Doubao 火山 arkcli）接入
- 数值口径修复三处：Claude 流式快照按 `message.id` 去重、Codex `input` 拆分 `cached`、Kimi 只认 `usage.record`

## v0.1.1

- 修复状态栏面板首次弹出时的落位与尺寸

## v0.1.0

- 首版：CLI 账单 + 本地看板 + macOS/Windows 状态栏应用，三形态一次给齐
