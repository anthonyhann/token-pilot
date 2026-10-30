// 把额度查询的底层错误翻译成用户能看懂、能动手的话。
//
// 背景：额度查询走 `python3 -c` 发 HTTP 请求，底层异常直接冒到界面上，
// 用户看到的是
//   <urlopen error [Errno 8] nodename nor servname provided, or not known>
// 这句话对用户零信息——既没说是什么问题，也没说能怎么办。
//
// 这里按错误特征分类。不认识的错误原样返回，不硬套：编造的提示比没有更糟。

/** 网络/DNS 类：解析不到域名、连不上、超时 */
const NETWORK_PATTERNS = [
  'nodename nor servname', // macOS DNS 失败
  'name or service not known', // Linux DNS 失败
  'temporary failure in name resolution',
  'getaddrinfo',
  'urlopen error',
  'connection refused',
  'connection reset',
  'timed out',
  'timeout',
  'network is unreachable',
  'no route to host',
  'ssl',
  'certificate',
];

export function explainQuotaError(raw: string): string {
  const low = raw.toLowerCase();

  if (NETWORK_PATTERNS.some((p) => low.includes(p))) {
    // DNS 失败单独说，因为自建 DNS / 公司网络环境下最常见
    if (low.includes('nodename') || low.includes('name or service') || low.includes('getaddrinfo')) {
      return '域名解析失败，连不上该平台的服务器（DNS 或网络被拦截）。开启系统代理后重试';
    }
    return '网络请求失败，连不上该平台的服务器。检查网络或开启系统代理后重试';
  }

  if (/401|403|unauthorized|forbidden|api key/i.test(raw)) {
    return 'API Key 无效或已过期';
  }
  if (/429|rate limit/i.test(raw)) {
    return '请求过于频繁被限流，稍后重试';
  }
  if (/5\d\d/.test(raw)) {
    return '平台服务端异常，稍后重试';
  }
  return raw;
}
