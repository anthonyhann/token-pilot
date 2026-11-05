// 声明式余额 provider —— 锁住三个最容易出错的行为：
//   1. 解析不出数字时必须返回 null，绝不能返回 0（显示 ¥0 比报错更误导）
//   2. 未验证的端点不许执行（网关对错误路径也返 401，只看状态码会误判）
//   3. key 只能以掩码形式出现在数据契约里，任何情况下不泄明文

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BALANCE_CATALOG,
  extractBalance,
  readPath,
  toNumber,
  verifiedSpecs,
  type BalanceApiSpec,
} from '../src/core/quota/providers/catalog.ts';

const spec = (over: Partial<BalanceApiSpec> = {}): BalanceApiSpec => ({
  id: 't',
  displayName: 'T',
  endpoint: 'https://example.com/balance',
  auth: 'bearer',
  amount: { path: 'data.balance', kind: 'balance' },
  currency: 'CNY',
  keyUrl: '',
  verified: '2026-01-01',
  ...over,
});

// ── 路径解析 ──

test('readPath 支持点号与数组下标', () => {
  assert.equal(readPath({ a: { b: [{ c: 42 }] } }, 'a.b[0].c'), 42);
  assert.equal(readPath({ a: [{ x: 1 }, { x: 2 }] }, 'a[1].x'), 2);
  assert.equal(readPath({ a: 1 }, 'a'), 1);
});

test('readPath 缺字段返回 undefined，不抛错', () => {
  assert.equal(readPath({}, 'a.b.c'), undefined);
  assert.equal(readPath(null, 'a'), undefined);
  assert.equal(readPath({ a: {} }, 'a.b[0]'), undefined);
});

test('toNumber 只接受真实数字，字符串空值返回 null', () => {
  assert.equal(toNumber(12.5), 12.5);
  assert.equal(toNumber('11.40'), 11.4);
  assert.equal(toNumber(''), null, '空字符串不能变成 0');
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber('--'), null);
  assert.equal(toNumber(NaN), null);
  assert.equal(toNumber(Infinity), null);
});

// ── 余额提取 ──

test('extractBalance 正常取值', () => {
  const b = extractBalance(spec(), { data: { balance: 12.5 } });
  assert.deepEqual(b, { amount: 12.5, currency: 'CNY' });
});

test('extractBalance 解析失败返回 null 而不是 0', () => {
  // 这是最关键的一条：平台改字段名、账户没开通时，
  // 返回 0 会让用户以为「钱花光了」，返回 null 才能显示「解析失败」
  assert.equal(extractBalance(spec(), { data: {} }), null);
  assert.equal(extractBalance(spec(), { data: { balance: '--' } }), null);
  assert.equal(extractBalance(spec(), null), null);
  assert.equal(extractBalance(spec(), {}), null);
});

test('extractBalance 支持 scale 换算', () => {
  // 有的平台按「分」返回，100 分 = 1 元
  const s = spec({ amount: { path: 'data.balance', kind: 'balance', scale: 0.01 } });
  const b = extractBalance(s, { data: { balance: 1140 } });
  assert.deepEqual(b, { amount: 11.4, currency: 'CNY' });
});

test('extractBalance 能从响应里读币种', () => {
  const s = spec({
    amount: { path: 'balance_infos[0].total_balance', kind: 'balance' },
    currencyPath: 'balance_infos[0].currency',
  });
  const usd = extractBalance(s, { balance_infos: [{ currency: 'USD', total_balance: '5.00' }] });
  assert.deepEqual(usd, { amount: 5, currency: 'USD' });
  const cny = extractBalance(s, { balance_infos: [{ currency: 'CNY', total_balance: '9.00' }] });
  assert.deepEqual(cny, { amount: 9, currency: 'CNY' });
});

test('extractBalance 币种字段缺失时退回 spec 默认值', () => {
  const s = spec({ currency: 'USD', currencyPath: 'nope.currency' });
  const b = extractBalance(s, { data: { balance: 3 } });
  assert.deepEqual(b, { amount: 3, currency: 'USD' });
});

// ── 目录与启用规则 ──

test('只有 verified 非空的条目会被启用', () => {
  const enabled = verifiedSpecs();
  for (const s of enabled) {
    assert.notEqual(s.verified, null, `${s.id} 未验证却在启用列表里`);
  }
  // 未验证的条目应存在于目录但不被启用
  const unverified = BALANCE_CATALOG.filter((s) => s.verified === null);
  for (const s of unverified) {
    assert.ok(!enabled.some((e) => e.id === s.id), `${s.id} 未验证却被启用`);
  }
});

test('目录里每个条目字段完整', () => {
  for (const s of BALANCE_CATALOG) {
    assert.ok(s.id && s.id.trim(), '缺 id');
    assert.ok(s.displayName, `${s.id} 缺 displayName`);
    assert.match(s.endpoint, /^https:\/\//, `${s.id} 端点必须是 https`);
    assert.ok(['bearer', 'raw', 'x-api-key'].includes(s.auth), `${s.id} 鉴权方式非法`);
    assert.ok(s.amount.path, `${s.id} 缺金额字段路径`);
  }
});

test('目录 id 不重复（否则 quotaKeys 会互相覆盖）', () => {
  const ids = BALANCE_CATALOG.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.join(',')}`);
});

// ── key 掩码（安全关键） ──

test('数据契约里的 key 只有掩码，任何情况不含明文', async () => {
  const { buildDashboardData } = await import('../src/core/aggregate.ts');
  const { loadPricingNormalized } = await import('../src/core/pricing.ts');
  const SECRET = 'sk-supersecret-abcdefghijklmnop';
  const cfg = {
    quotaKeys: {
      deepseek: SECRET,
      moonshot: 'tiny',        // 短 key
      openrouter: '',          // 空值
    },
  };
  const d = await buildDashboardData([], cfg as never, loadPricingNormalized(7.2));
  const json = JSON.stringify(d.settings.quotaKeys);

  // 明文、长前缀、任何 8 字符以上的子串都不该出现
  assert.ok(!json.includes(SECRET), '出现了完整 key');
  assert.ok(!json.includes('supersecret'), '出现了 key 中段');
  assert.ok(!json.includes('abcdefghij'), '出现了 key 片段');
  assert.ok(!json.includes('tiny'), '短 key 不该显示任何字符');

  // 但必须能看出「配没配」
  const ds = d.settings.quotaKeys.find((k) => k.id === 'deepseek');
  assert.ok(ds?.masked, '已配置的平台要显示掩码');
  assert.ok(ds!.masked!.includes('•'), '掩码应含圆点');
  const mo = d.settings.quotaKeys.find((k) => k.id === 'moonshot');
  assert.equal(mo?.masked, '••••', '短 key 全遮');
  const or = d.settings.quotaKeys.find((k) => k.id === 'openrouter');
  assert.equal(or?.masked, null, '空 key 视为未配置');
});

// ── 两字段相减（OpenRouter 这类"只给累计值"的平台） ──

test('subtractPath：余额 = 累计充值 - 累计已用', () => {
  // 真实结构（2026-11-05 实测）：充了 0.339、用掉 0.339，剩余 0
  const s = spec({
    id: 'openrouter',
    amount: { path: 'data.total_credits', subtractPath: 'data.total_usage', kind: 'balance' },
    currency: 'USD',
  });
  const b = extractBalance(s, { data: { total_credits: 0.339163134, total_usage: 0.339163134 } });
  assert.ok(b, '应能解析');
  assert.equal(Number(b!.amount.toFixed(6)), 0, '余额必须是 0，不能是 total_credits 的 0.339');
  assert.equal(b!.currency, 'USD');
});

test('subtractPath：有剩额时算出真实剩余', () => {
  const s = spec({
    amount: { path: 'credits', subtractPath: 'usage', kind: 'balance' },
    currency: 'USD',
  });
  const b = extractBalance(s, { credits: 10, usage: 3.5 });
  assert.equal(b!.amount, 6.5);
});

test('subtractPath：任一字段缺失就返回 null，不拿半个数硬算', () => {
  const s = spec({ amount: { path: 'credits', subtractPath: 'usage', kind: 'balance' } });
  // 只有 credits 没有 usage：不能把 credits 当余额返回
  assert.equal(extractBalance(s, { credits: 10 }), null, '缺 usage 时不能退化成只取 credits');
  assert.equal(extractBalance(s, { usage: 3 }), null);
  assert.equal(extractBalance(s, { credits: 10, usage: null }), null);
  assert.equal(extractBalance(s, { credits: 'x', usage: 3 }), null);
});

test('OpenRouter 在目录里已标记 verified 且使用相减', () => {
  const or = BALANCE_CATALOG.find((s) => s.id === 'openrouter');
  assert.ok(or, '缺 OpenRouter 条目');
  assert.notEqual(or!.verified, null, '已用真实 key 验证，应标记 verified');
  assert.equal(or!.amount.subtractPath, 'data.total_usage', '必须减去 total_usage');
});

// ── 鉴权方式（实测过的坑） ──

test('MiniMax 必须用 bearer，裸 Authorization 会 1004', () => {
  const mm = BALANCE_CATALOG.find((s) => s.id === 'minimax');
  assert.ok(mm, '缺 MiniMax 条目');
  // 实测 2026-11-05：auth:'raw' 时返回
  // {"base_resp":{"status_code":1004,"status_msg":"login fail: Please carry the
  //   API secret key in the 'Authorization' field"}}——看着像 key 无效，
  // 其实是鉴权头格式错了。这类误诊最费时间，锁死。
  assert.equal(mm!.auth, 'bearer', 'MiniMax 要用 Bearer');
});

test('只有明确需要裸 key 的平台才用 raw', () => {
  // raw 是少数派：目前没有任何已验证平台需要它。
  // 若将来要加，必须像 MiniMax 一样用真实 key 实测过再写。
  const rawOnes = BALANCE_CATALOG.filter((s) => s.auth === 'raw');
  for (const s of rawOnes) {
    assert.equal(s.verified, null, `${s.id} 用 raw 且标称已验证，需复核鉴权头格式`);
  }
});
