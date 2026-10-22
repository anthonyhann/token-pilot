// token-pilot serve — 本地 HTTP 服务（默认 127.0.0.1:17895）
// 路由：
//   GET  /           完整看板（注入当前数据）
//   GET  /panel      菜单栏面板预览
//   GET  /api/data   DashboardData JSON（前端轮询）
//   GET  /api/config 当前配置
//   POST /api/config 保存配置（设置弹窗写回）
// 后台每 10s 增量采集 + 重聚合，同时写 ~/.token-pilot/dashboard-data.json 给 Tauri 菜单栏。

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Collector } from '../core/collector.ts';
import { autoOverrides } from '../core/price-fetch.ts';
import { buildDashboardData } from '../core/aggregate.ts';
import { loadPricingWithOverrides } from '../core/pricing.ts';
import { loadConfig, saveConfig, fxRate, monthlyBudgetCny, DATA_PATH, CONFIG_DIR } from '../core/config.ts';
import { notify } from '../core/alert.ts';
import type { DashboardData } from '../core/contract.ts';
import type { TokenPilotConfig } from '../core/config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../../web');

export function readWebAsset(name: string): string | null {
  const p = path.join(WEB_DIR, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

export function injectData(html: string, data: DashboardData): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return html.replace('window.__TP_DATA__=null;', `window.__TP_DATA__=${json};`);
}

export function writeDashboardDataFile(data: DashboardData): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data), 'utf8');
}

export interface ServeState {
  collector: Collector;
  data: DashboardData | null;
  refreshing: boolean;
  lastAlertPct: number;
}

export async function refreshOnce(state: ServeState): Promise<DashboardData> {
  const cfg = loadConfig();
  const pricing = loadPricingWithOverrides({ ...autoOverrides(), ...(cfg.priceOverrides ?? {}) }, fxRate(cfg));
  const { events } = await state.collector.sync();
  const data = await buildDashboardData(events, cfg, pricing);
  state.data = data;
  writeDashboardDataFile(data);
  // 预算告警（每跨一次阈值提醒一次）
  if (data.budget) {
    const threshold = cfg.alertOnPercent ?? 80;
    const pct = data.budget.pct;
    if (pct >= threshold && Math.floor(pct / 10) > Math.floor(state.lastAlertPct / 10)) {
      notify('token-pilot 预算告警', `本月已用 ${pct.toFixed(0)}%（${data.budget.spentCny.toFixed(0)} / ${data.budget.monthlyCny.toFixed(0)} 元）`);
    }
    state.lastAlertPct = pct;
  }
  return data;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

export async function serve(port = 17895): Promise<void> {
  const state: ServeState = { collector: new Collector(), data: null, refreshing: false, lastAlertPct: 0 };

  const refresh = async () => {
    if (state.refreshing) return;
    state.refreshing = true;
    try { await refreshOnce(state); } catch { /* 下一轮再来 */ } finally { state.refreshing = false; }
  };
  await refresh();
  setInterval(refresh, 10_000);

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/api/data') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(state.data ?? {}));
        return;
      }
      if (url === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(loadConfig()));
        return;
      }
      if (url === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const patch = JSON.parse(body) as Partial<TokenPilotConfig>;
        const cur = loadConfig();
        const next: TokenPilotConfig = { ...cur, ...patch };
        saveConfig(next);
        await refresh();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === '/' || url === '/index.html') {
        const html = readWebAsset('dashboard.html');
        if (!html || !state.data) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('看板资源未就绪');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(injectData(html, state.data));
        return;
      }
      if (url === '/panel') {
        const html = readWebAsset('panel.html');
        if (!html || !state.data) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('面板资源未就绪');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(injectData(html, state.data));
        return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`token-pilot serve · http://127.0.0.1:${port}（数据不出本机）`);
  console.log(`菜单栏面板预览：http://127.0.0.1:${port}/panel`);
  // 自动打开看板
  try {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', `http://127.0.0.1:${port}`] : [`http://127.0.0.1:${port}`];
    spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 手动打开即可 */ }
}

// dash 命令：静态 bake 一份带数据的 HTML（不起服务）
export async function bakeDashboard(): Promise<string> {
  const state: ServeState = { collector: new Collector(), data: null, refreshing: false, lastAlertPct: 0 };
  const data = await refreshOnce(state);
  const html = readWebAsset('dashboard.html');
  if (!html) throw new Error('web/dashboard.html 不存在');
  const out = path.join(CONFIG_DIR, 'dashboard.html');
  writeFileSync(out, injectData(html, data), 'utf8');
  return out;
}

export function budgetLine(cfg: TokenPilotConfig): string {
  const b = monthlyBudgetCny(cfg);
  return b ? `¥${b}` : '未设置';
}
