// 版本号可追溯 —— 用户要能在面板/看板/CLI 上说清「我装的是哪一版」。
//
// 这组测试锁三件事：
//   1. 数据契约里带 appVersion，且等于 package.json（单一真源）
//   2. 三处版本号（package.json / tauri.conf.json / Cargo.toml）一致
//      —— 不一致时 CI 会拦，但本地先报错更早
//   3. 前端确实把这个字段渲染出来了（防止后端给了、前端忘接）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../src/core/version.ts';
import { buildDashboardData } from '../src/core/aggregate.ts';
import type { PricingTable } from '../src/core/pricing.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const pricing: PricingTable = {
  models: { 'm': { provider: 't', input: 1, output: 2, cacheRead: 0.1, cacheCreation: 1.25 } },
  fallback: { provider: 'x', input: 1, output: 5 },
};

test('APP_VERSION 来自 package.json', () => {
  assert.equal(APP_VERSION, readJson('package.json').version);
  // 形如 1.2.3 / 1.2.3-beta.1，不要出现空串或 0.0.0 这种兜底值（说明读取失败）
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
  assert.notEqual(APP_VERSION, '0.0.0');
});

test('三处版本号一致：package.json = tauri.conf.json = Cargo.toml', () => {
  const pkg = readJson('package.json').version;
  const conf = readJson('menubar/src-tauri/tauri.conf.json').version;
  const cargoToml = readFileSync(resolve(ROOT, 'menubar/src-tauri/Cargo.toml'), 'utf8');
  const cargo = cargoToml.match(/^version = "([^"]+)"/m)?.[1];
  assert.equal(conf, pkg, 'tauri.conf.json 与 package.json 版本不一致');
  assert.equal(cargo, pkg, 'Cargo.toml 与 package.json 版本不一致');
});

test('dashboard 数据里带 appVersion', async () => {
  const d = await buildDashboardData([], {}, pricing);
  assert.equal(d.appVersion, APP_VERSION);
});

test('前端真的渲染了版本号（面板 + 看板）', () => {
  const panel = readFileSync(resolve(ROOT, 'web/panel.html'), 'utf8');
  const dash = readFileSync(resolve(ROOT, 'web/dashboard.html'), 'utf8');
  // 面板：footer 有版本占位 + 有调用 app_version 命令
  assert.match(panel, /class="ver-badge"/, "面板标题区缺少版本号占位");
  assert.match(panel, /app_version/, '面板没有调用 app_version 命令');
  // 看板：footer 文案里拼了版本
  assert.match(dash, /app_version/, '看板没有调用 app_version 命令');
  assert.match(dash, /verText\(\)/, '看板 footer 没有渲染版本号');
});

test('打包副本与源同步（Tauri 真正打包的是 menubar/src）', () => {
  for (const [src, dst] of [
    ['web/dashboard.html', 'menubar/src/dashboard.html'],
    ['web/panel.html', 'menubar/src/index.html'],
  ]) {
    assert.ok(existsSync(resolve(ROOT, dst)), `${dst} 不存在`);
    assert.equal(
      readFileSync(resolve(ROOT, dst), 'utf8'),
      readFileSync(resolve(ROOT, src), 'utf8'),
      `${dst} 与 ${src} 不一致，跑 npm run sync:assets`,
    );
  }
});
