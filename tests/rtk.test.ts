// RTK 接入层：来源判定 / 冲突预检 / 失败不假装成功
//
// 这一组的来历：2026-10-27 排查发现四个真实缺陷——
//   1. 桌面端（Tauri）勾选完全无效，静默什么都没做
//   2. 系统里已有 brew 主仓库的 rtk 时，rtk-oss 必然冲突，但代码没查
//   3. 冲突后回退 brew install rtk，因为已装着而误报「安装成功」
//   4. 失败信息被前端吞成「仅本地预览生效」，用户不知道原因
// 这里用真实系统状态做断言（本机装了 rtk 0.49.0 的话会命中 foreign 分支），
// 不 mock 外部命令——mock 掉就测不出「是不是真的看错了来源」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rtkStatus, rtkInstalled, installRtk, uninstallRtk } from '../src/core/rtk.ts';

test('rtkStatus：返回结构完整且 source 取值合法', async () => {
  const st = await rtkStatus();
  assert.equal(typeof st.installed, 'boolean');
  assert.ok(['ours', 'foreign', 'none'].includes(st.source), `非法 source: ${st.source}`);
  assert.equal(typeof st.detail, 'string');
  assert.ok(st.detail.length > 0, 'detail 不能为空——前端要直接展示');

  // installed 与 source 必须自洽
  if (st.installed) {
    assert.notEqual(st.source, 'none', 'installed=true 时 source 不能是 none');
  } else {
    assert.equal(st.source, 'none');
    assert.equal(st.version, '');
  }
});

test('rtkInstalled：与 rtkStatus().installed 一致（避免两套判断口径）', async () => {
  const st = await rtkStatus();
  assert.equal(await rtkInstalled(), st.installed);
});

test('installRtk：已有 rtk-oss（不含 engine）时必须明确报互斥，不得误报成功', async () => {
  const before = await rtkStatus();
  if (before.source !== 'foreign') return; // 只对「装了 oss 版」有意义
  const r = await installRtk();
  assert.equal(r.ok, false, '已装 rtk-oss 时安装完整版必须失败，不能假装成功');
  assert.match(r.message, /互斥|卸载|rtk-oss/, `应说清互斥与解法，实际：${r.message}`);
});

test('installRtk：已装完整版时不得重复安装，返回值里要能看出原因', async () => {
  const before = await rtkStatus();
  if (before.source !== 'ours') return;
  const r = await installRtk();
  // 已经装好时，要么直接成功（hook 已接），要么失败但说明白原因（如无写权限）
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.message.length > 0, '必须给出说明');
});

test('uninstallRtk：不擅自删除 rtk-oss 等外来版本', async () => {
  const before = await rtkStatus();
  if (before.source !== 'foreign') return;
  const r = await uninstallRtk();
  assert.equal(r.ok, false, '外来 rtk 不应被本工具卸载');
  assert.match(r.message, /手动|不是本工具/, `应提示手动处理，实际：${r.message}`);
  // 卸载被拒后，rtk 必须还在
  const after = await rtkStatus();
  assert.equal(after.installed, true, '被拒的卸载不能真的删掉东西');
});

test('未安装时卸载是幂等的（返回 ok，不报错）', async () => {
  const st = await rtkStatus();
  if (st.installed) return; // 只在本机没装时验证
  const r = await uninstallRtk();
  assert.equal(r.ok, true);
  assert.match(r.message, /无需卸载/);
});
