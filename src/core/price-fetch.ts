// 自动补价 — 对采集到但定价表缺失的模型，每天最多一次去网络查公开目录价
// 策略：按 provider 找官方定价页 → r.jina.ai 读成文本 → 在模型名附近抓价格数字
// 所有自动填充都标记 needsReview，人工可在看板「数据设置」里核对修改。

import { loadUnknown, markPriced, markFailed, saveUnknown, type UnknownModel } from './unknown-models.ts';

const PROVIDER_PRICE_PAGES: Record<string, string> = {
  anthropic: 'https://claude.com/pricing#api',
  openai: 'https://developers.openai.com/api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  glm: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
  kimi: 'https://platform.kimi.com/docs/pricing/chat',
  qwen: 'https://help.aliyun.com/zh/model-studio/models',
  doubao: 'https://www.volcengine.com/docs/82379/1099320',
  minimax: 'https://platform.minimax.cn/docs/pricing/overview',
  hunyuan: 'https://cloud.tencent.com/document/product/1729/97731',
  grok: 'https://grok.cadn.net.cn/docs_cn/models.html',
  gemini: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing?hl=zh-CN',
};

function providerFromModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gpt') || m.includes('o4') || m.includes('codex')) return 'openai';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('glm')) return 'glm';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('doubao') || m.includes('seed')) return 'doubao';
  if (m.includes('minimax')) return 'minimax';
  if (m.includes('hunyuan')) return 'hunyuan';
  if (m.includes('gemini') || m.includes('google/')) return 'google';
  return '';
}

// 从定价页文本里抓模型名附近的价格（$/1M 或 ¥/1M 都试）
function extractPrices(text: string, model: string): { input: number; output: number; cny: boolean } | null {
  const idx = text.toLowerCase().indexOf(model.toLowerCase());
  if (idx < 0) return null;
  // 取模型名前后 800 字符窗口
  const win = text.slice(Math.max(0, idx - 400), idx + 800);
  // 价格形态：$3.00 / $0.15 / 3.00 / ¥2 / 0.5 元
  const nums = [...win.matchAll(/[$¥]?\s*(\d+(?:\.\d+)?)\s*(?:USD|美元|元|\/1M|\/ 1M|per 1M|\/MTok)?/g)]
    .map((m) => parseFloat(m[1]))
    .filter((n) => n > 0.001 && n < 10000);
  if (nums.length < 2) return null;
  // 粗规则：窗口里最小的两个正数大概率是 input/output（output >= input 更常见）
  nums.sort((a, b) => a - b);
  const input = nums[0];
  const output = nums.length > 1 ? nums[1] : nums[0] * 3;
  const cny = win.includes('¥') || win.includes('元') || win.includes('人民币');
  return { input, output, cny };
}

async function fetchPricePage(url: string): Promise<string | null> {
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

// 对 unknown-models 里待补价的模型逐个查价（每次最多 3 个，失败记数）
export async function autoFetchPrices(usdToCny: number, maxPerRun = 3): Promise<string[]> {
  const state = loadUnknown();
  const notes: string[] = [];
  const candidates = Object.values(state)
    .filter((u) => !u.autoPrice && (u.failedAttempts ?? 0) < 3)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, maxPerRun);

  for (const u of candidates) {
    const prov = providerFromModel(u.model);
    const page = PROVIDER_PRICE_PAGES[prov];
    if (!page) { markFailed(u.model); continue; }
    const text = await fetchPricePage(page);
    if (!text) { markFailed(u.model); continue; }
    const got = extractPrices(text, u.model);
    if (!got) { markFailed(u.model); continue; }
    // 统一存 ¥/1M
    const price = got.cny
      ? { input: got.input, output: got.output }
      : { input: got.input * usdToCny, output: got.output * usdToCny };
    markPriced(u.model, price, page);
    notes.push(`${u.model}: ¥${price.input.toFixed(2)}/¥${price.output.toFixed(2)}（来源 ${page}，待核对）`);
  }
  return notes;
}

// 把已补价的模型合并进配置的价格覆写（auto 标记保留在 unknown-models.json 里供前端标注）
export function autoOverrides(): Record<string, { input: number; output: number; cacheRead?: number }> {
  const state = loadUnknown();
  const out: Record<string, { input: number; output: number; cacheRead?: number }> = {};
  for (const u of Object.values(state)) {
    if (u.autoPrice) out[u.model] = u.autoPrice;
  }
  return out;
}

export function reviewInfo(): Record<string, UnknownModel> {
  const state = loadUnknown();
  const out: Record<string, UnknownModel> = {};
  for (const [k, u] of Object.entries(state)) {
    if (u.autoPrice) out[k] = u;
  }
  void saveUnknown;
  return out;
}
