// 版本号 —— 单一真源是 package.json。
//
// 为什么要这个模块：以前「app 的版本」只存在于二进制里，用户在看板和面板上
// 看不到自己装的是哪一版，报问题时说不清版本，判断「自动更新有没有生效」
// 也只能靠猜。现在版本号随数据一起下发给前端（DashboardData.appVersion）。
//
// 为什么不 `import pkg from '../../package.json'`：那样 tsc 会把源码相对路径
// 原样保留，编译后 dist/core/version.js 去读 dist 外的 package.json，只能靠
// 目录布局碰运气（rootDir=src 时必失效）。这里按「从 dist/core/ 回到包根」
// 解析，不管 cwd 在哪都对。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // .../dist/core
    const pkgPath = resolve(here, '..', '..', 'package.json'); // -> 包根
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0'; // 版本读不到不该让看板挂掉
  }
}

export const APP_VERSION: string = readPackageVersion();
