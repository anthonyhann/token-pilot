// doctor 自检：结构与判定逻辑
//
// 这组测试不 mock 文件系统，直接用本机真实状态断言「结构合理」。
// 理由：doctor 的价值就在反映真实环境，mock 掉就等于测了个假函数。
// 需要验证的具体判定（比如数据过期、定价表缺失）通过纯函数边界测试覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, formatDoctor } from '../src/core/doctor.ts';

test('runDoctor：返回结构完整，计数与条目一致', async () => {
  const r = await runDoctor();

  assert.ok(Array.isArray(r.items), 'items 必须是数组');
  assert.ok(r.items.length > 0, '至少要检查出几项');

  const ok = r.items.filter((i) => i.level === 'ok').length;
  const warn = r.items.filter((i) => i.level === 'warn').length;
  const error = r.items.filter((i) => i.level === 'error').length;

  assert.equal(r.ok, ok, 'ok 计数必须与 items 一致');
  assert.equal(r.warn, warn, 'warn 计数必须与 items 一致');
  assert.equal(r.error, error, 'error 计数必须与 items 一致');
});

test('runDoctor：每条都有标题和说明，level 合法', async () => {
  const r = await runDoctor();
  const legal = new Set(['ok', 'warn', 'error', 'info']);

  for (const i of r.items) {
    assert.ok(legal.has(i.level), `非法 level: ${i.level}`);
    assert.ok(i.title && i.title.length > 0, '标题不能为空');
    assert.ok(i.detail && i.detail.length > 0, '说明不能为空');
    // 结论要能直接给人看，不能是 undefined 拼出来的
    assert.ok(!i.detail.includes('undefined'), `说明里出现 undefined: ${i.detail}`);
  }
});

test('runDoctor：建议只来自 warn/error，且都带 fix', async () => {
  const r = await runDoctor();
  for (const a of r.advice) {
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0, '建议不能是空串');
  }
  // 建议条数不应超过 warn+error 总数
  assert.ok(r.advice.length <= r.warn + r.error, '建议数不应超过问题数');
});

test('formatDoctor：输出含汇总与建议，且不出现 undefined', () => {
  const fake = {
    items: [
      { level: 'ok' as const, title: '测试项', detail: '一切正常' },
      { level: 'warn' as const, title: '警告项', detail: '有点问题', fix: '这样修' },
    ],
    ok: 1,
    warn: 1,
    error: 0,
    advice: ['这样修'],
  };
  const out = formatDoctor(fake);

  assert.ok(out.includes('环境自检'), '要有标题');
  assert.ok(out.includes('测试项'));
  assert.ok(out.includes('警告项'));
  assert.ok(out.includes('这样修'), '建议要出现在输出里');
  assert.ok(out.includes('1 项正常'), '要有汇总');
  assert.ok(!out.includes('undefined'), '输出里不能出现 undefined');
});

test('formatDoctor：全部正常时不出现「接下来可以做」', () => {
  const fake = {
    items: [{ level: 'ok' as const, title: '好的', detail: '正常' }],
    ok: 1,
    warn: 0,
    error: 0,
    advice: [],
  };
  const out = formatDoctor(fake);
  assert.ok(out.includes('一切就绪'), '全绿时给正向结论');
  assert.ok(!out.includes('接下来可以做'), '没有问题时不列空建议');
});
