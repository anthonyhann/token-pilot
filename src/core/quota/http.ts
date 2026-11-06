// 额度查询的统一 HTTP 入口。
//
// 历史：这里曾经借 `python3 -c` + urllib 发请求，理由是「不引入 npm 依赖」。
// 但 node 18+ 自带 fetch（本项目 engines 就是 >=18），借 python3 反而引入了
// 一个更脆的系统依赖（macOS 12 之后不预装 python3），错误文案还要跨语言翻译。
// 现在统一走 node fetch，错误翻译仍集中在 errors.ts。

import { explainQuotaError } from './errors.js';

export type HttpJsonResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number };

/**
 * GET 一个返回 JSON 的接口。
 *
 * 归一化约定：
 *   - 网络/超时异常 → ok:false + explainQuotaError 翻译过的人话
 *   - 非 2xx → ok:false + status（调用方可以按状态码给更具体的提示）
 *   - 2xx 但响应不是 JSON → ok:false（网关拦截时常返回 HTML，别当数据解析）
 */
export async function httpGetJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<HttpJsonResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'token-pilot', Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // node fetch 把底层原因（DNS / 拒连 / 超时）挂在 cause 上，
    // 不带出来 explainQuotaError 分类不到
    const cause = (e as { cause?: unknown }).cause;
    const msg = `${String(e)} ${cause ? String(cause) : ''}`.slice(0, 200);
    return { ok: false, error: explainQuotaError(msg) };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: explainQuotaError(`HTTP ${res.status} ${res.statusText}`.trim()),
    };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: explainQuotaError(String(e).slice(0, 150)) };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      error: `接口返回的不是 JSON（可能端点已变更）：${text.slice(0, 120)}`,
    };
  }
}
