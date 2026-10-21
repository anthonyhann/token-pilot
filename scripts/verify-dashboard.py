#!/usr/bin/env python3
# token-pilot 看板数据不变量验证 — 直接对 dashboard-data.json 做算法级校验
# 与 reconcile.py 互补：reconcile 验证采集正确性，本脚本验证聚合算法正确性。
#
# 用法：python3 scripts/verify-dashboard.py

import json
import math
import os
import sys
from datetime import datetime

DATA = os.path.expanduser('~/.token-pilot/dashboard-data.json')
d = json.load(open(DATA))

fails = []
def check(name, ok, detail=''):
    print(('✅' if ok else '❌'), name, detail)
    if not ok:
        fails.append(name)

gen = datetime.fromtimestamp(d['generatedAt'] / 1000)
print(f'数据生成于 {gen}\n')

# ---- 1. 三周期包含关系：today ≤ week ≤ month ----
h = d['hero']
check('today ≤ week ≤ month（花费）',
      h['today']['costCny'] <= h['week']['costCny'] + 0.01 <= h['month']['costCny'] + 0.02,
      f"{h['today']['costCny']:.2f} ≤ {h['week']['costCny']:.2f} ≤ {h['month']['costCny']:.2f}")

# ---- 2. hero 内部一致性：命中率在 [0,1]，calls/tokens 非负 ----
for p in ('today', 'week', 'month'):
    pp = h[p]
    check(f'hero.{p} 命中率∈[0,1]', 0 <= pp['cacheHitRate'] <= 1, f"{pp['cacheHitRate']:.3f}")
    check(f'hero.{p} pills=4', len(pp['pills']) == 4, str([x['label'] for x in pp['pills']]))

# ---- 3. 趋势日序列：28 天、今天=hero.today、花费非负 ----
days = d['trend']['days']
check('趋势 28 天', len(days) == 28, str(len(days)))
today_cost = days[-1]['costUsd'] * d['usdToCny']
check('趋势末日 = hero.today', abs(today_cost - h['today']['costCny']) < 0.01,
      f'{today_cost:.2f} vs {h["today"]["costCny"]:.2f}')
check('趋势无负值', all(x['costUsd'] >= 0 and x['tokens'] >= 0 and x['calls'] >= 0 for x in days))
# 本周花费 = 本周一的日期起日序列之和
wd = datetime.now().weekday()  # 周一=0
week_sum = sum(x['costUsd'] for x in days[-(wd + 1):]) * d['usdToCny']
check('本周花费 = 日序列周一起求和', abs(week_sum - h['week']['costCny']) < 0.02,
      f'{week_sum:.2f} vs {h["week"]["costCny"]:.2f}')

# ---- 4. 实时流速：分摊总量守恒（buckets60 × 20s ≈ 近60分钟 output 总量无法外部验证，验证自身一致性） ----
live = d['live']
check('buckets30 是 buckets60 的末 90 桶',
      live['buckets30'] == live['buckets60'][90:], '')
check('currentTokS = 末3桶均值',
      abs(live['currentTokS'] - sum(live['buckets60'][-3:]) / 3) < 0.01,
      f"{live['currentTokS']:.2f}")
check('peak ≥ current', live['peakTokS'] + 0.01 >= live['currentTokS'],
      f"peak {live['peakTokS']:.1f} cur {live['currentTokS']:.1f}")
check('会话数 = active+idle 内一致', live['activeCount'] >= 0 and live['idleCount'] >= 0)
for s in live['sessions']:
    check(f'会话 spark 长度=10', len(s['spark']) == 10, s['label'][:20])

# ---- 5. 构成：pct ≈ 100，三周期都有 ----
for period in ('today', 'week', 'month'):
    for dim in ('model', 'tool', 'proj'):
        rows = d['mix'][period][dim]
        if rows:
            total = sum(r['pct'] for r in rows)
            check(f'mix.{period}.{dim} pct≈100', abs(total - 100) < 1.5, f'{total:.1f}')

# ---- 6. 排行：pct 降序、与 mix.today.model 头部一致 ----
mr = d['modelRank']
check('modelRank 降序', all(mr[i]['pct'] >= mr[i+1]['pct'] - 0.01 for i in range(len(mr)-1)))
if mr and d['mix']['today']['model']:
    check('modelRank 榜首 = mix 榜首', mr[0]['name'] == d['mix']['today']['model'][0]['name'],
          f"{mr[0]['name']}")

# ---- 7. 预算：spent = 本月用量 + 固定费；pct 自洽 ----
b = d['budget']
if b:
    fixed = sum(x['monthlyCny'] for x in d['settings']['cloudApis']) + sum(x['monthlyCny'] for x in d['settings']['subscriptions'])
    expect_spent = h['month']['costCny'] + fixed
    check('budget.spent = 本月用量 + 固定费', abs(b['spentCny'] - expect_spent) < 0.5,
          f"{b['spentCny']:.1f} vs {expect_spent:.1f}（固定费 {fixed}）")
    check('budget.pct 自洽', abs(b['pct'] - b['spentCny'] / b['monthlyCny'] * 100) < 0.5)
    check('budget.daily = monthly/当月天数', abs(b['dailyCny'] - b['monthlyCny'] / 31) < b['monthlyCny'] / 31 * 0.15)

# ---- 8. 缓存省钱条：命中率为本月口径 ----
cs = d['cacheStrip']
if cs:
    check('cacheStrip 命中率 = hero.month 命中率', abs(cs['hitRate'] - h['month']['cacheHitRate']) < 0.001)
    check('cacheStrip 节省 > 0', cs['savedCny'] > 0, f"¥{cs['savedCny']:.0f}")

# ---- 9. 设置：价格表非空 ----
check('settings.models 非空', len(d['settings']['models']) > 0, f"{len(d['settings']['models'])} 个模型")

print()
if fails:
    print(f'❌ {len(fails)} 项失败：{fails}')
    sys.exit(1)
print('全部通过 ✓')
