# Contributing to token-pilot

Thanks for taking a look. This is a small, single-maintainer project, so a few conventions keep things fast.

中文英文都可以，直接用你顺手的语言提 issue 或 PR。

---

## 最快的三种参与方式

**1. 报一个数据不准的 bug**（最有价值）

这是账单工具，数据错了比功能少更严重。如果你发现某个模型的 token 数或金额不对，请附上：

- 是哪个宿主（Claude Code / Codex / Kimi Code / …）
- 该模型的原始日志里 `usage` 字段长什么样（**请先删掉 prompt 和回复内容**，只留数字）
- 你期望的金额 vs token-pilot 算出来的金额

**2. 修正价格表**

`pricing/models.json` 是纯数据文件，改错价是最容易上手的贡献。每条价格请附上官方定价页链接，方便复核。

**3. 加一个宿主 adapter**

`src/adapters/` 下一个文件就是一个宿主。最小实现只需三件事：

```ts
export const yourAdapter: Adapter = {
  meta: { id: 'your-tool', displayName: 'Your Tool', detectPaths: ['~/.your-tool'] },
  async detect() { /* 目录/文件存在就返回 true */ },
  async readEvents(sinceMs) { /* 返回 UsageEvent[]，字段见 src/core/schema.ts */ },
};
```

然后在 `src/core/collector.ts` 的 `ALL_ADAPTERS` 数组里加进去。参考 `src/adapters/codex.ts`（约 170 行，含注释）是最完整的单文件例子。

注意：只读日志，不要注入 hook、不要改用户配置——这是项目的硬性约束。

---

## 提交 PR 之前

```bash
npm install
npm test                          # 单元测试必须全绿
npx tsc --noEmit                  # 类型检查
node scripts/sync-web-assets.js --check   # 改过 web/ 下的 HTML 时要同步打包副本
```

如果改了 `web/dashboard.html` 或 `web/panel.html`，记得跑 `npm run sync:assets`——桌面端打包读的是 `menubar/src/` 那份副本。

### 一个约定

**改行为要带测试。** 这个项目的历史上出过几次「逻辑对了但没人验证」的问题（比如安装了却报成功），所以涉及判定、安装、路径解析的改动，请附一个能复现该场景的测试。

---

## 代码风格

- TypeScript，不加新依赖除非有充分理由（目前零运行时依赖是刻意保持的）
- 注释写「为什么」不写「做了什么」——代码本身能说明在做什么
- 中文注释和英文注释都行，同一文件内保持一致

---

## 关于数据与隐私

token-pilot 的核心承诺是**只读本地日志，数据不出本机**。任何让数据离开用户机器的 PR（上报、云同步、远程统计）**不会合入**，无论实现多干净。

---

## 报告安全问题

请不要开公开 issue，直接邮件 [bmomhan@gmail.com](mailto:bmomhan@gmail.com)。

---

## License

提交的代码按 [MIT](LICENSE) 授权。
