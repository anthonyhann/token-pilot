#!/usr/bin/env python3
# token-pilot 数据对账 — 独立重算原始日志，与 CLI 输出比对
# 故意不用适配器代码：这是第三方视角的独立审计。
# 注意：不按 mtime 跳文件，顺便验证 mtime 快跳的正确性。
#
# 用法：python3 scripts/reconcile.py [month|today]

import json
import os
import sys
import glob
from datetime import datetime

HOME = os.path.expanduser('~')
MODE = sys.argv[1] if len(sys.argv) > 1 else 'month'

now = datetime.now()
if MODE == 'today':
    since = now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
else:
    since = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()


def blank():
    return dict(input=0, output=0, cache_read=0, cache_creation=0, calls=0)


def audit_claude():
    """~/.claude/projects/**/*.jsonl — 按 message.id 去重取最大"""
    agg = blank()
    by_id = {}
    for f in glob.glob(os.path.join(HOME, '.claude', 'projects', '**', '*.jsonl'), recursive=True):
        try:
            with open(f, 'r', errors='replace') as fh:
                for line in fh:
                    if '"usage"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    m = d.get('message') or {}
                    u = m.get('usage')
                    model = m.get('model')
                    if not u or not model or model in ('<synthetic>', 'error'):
                        continue
                    ts = d.get('timestamp')
                    if not ts:
                        continue
                    try:
                        t = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
                    except Exception:
                        continue
                    if t < since:
                        continue
                    mid = m.get('id') or f'{f}#{id(line)}'
                    total = (u.get('input_tokens') or 0) + (u.get('output_tokens') or 0) \
                        + (u.get('cache_read_input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0)
                    prev = by_id.get(mid)
                    if prev is None or total > prev[0]:
                        by_id[mid] = (total, u)
        except Exception:
            continue
    for _, u in by_id.values():
        agg['input'] += u.get('input_tokens') or 0
        agg['output'] += u.get('output_tokens') or 0
        agg['cache_read'] += u.get('cache_read_input_tokens') or 0
        agg['cache_creation'] += u.get('cache_creation_input_tokens') or 0
        agg['calls'] += 1
    return agg


def audit_codex():
    """~/.codex/sessions/**/*.jsonl — token_usage_record；input 含 cached 子集"""
    agg = blank()
    for f in glob.glob(os.path.join(HOME, '.codex', 'sessions', '**', '*.jsonl'), recursive=True):
        try:
            with open(f, 'r', errors='replace') as fh:
                for line in fh:
                    if 'token_usage_record' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get('type') != 'token_usage_record':
                        continue
                    u = (d.get('payload') or {}).get('usage') or {}
                    ts = d.get('timestamp')
                    if not ts:
                        continue
                    try:
                        t = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
                    except Exception:
                        continue
                    if t < since:
                        continue
                    cached = u.get('cached_input_tokens') or 0
                    agg['input'] += max((u.get('input_tokens') or 0) - cached, 0)
                    agg['output'] += u.get('output_tokens') or 0
                    agg['cache_read'] += cached
                    agg['cache_creation'] += u.get('cache_write_input_tokens') or 0
                    agg['calls'] += 1
        except Exception:
            continue
    return agg


def audit_kimi():
    """~/.kimi-code/sessions/**/wire.jsonl — 只认 usage.record"""
    agg = blank()
    for f in glob.glob(os.path.join(HOME, '.kimi-code', 'sessions', '**', 'wire.jsonl'), recursive=True):
        try:
            with open(f, 'r', errors='replace') as fh:
                for line in fh:
                    if '"usage.record"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get('type') != 'usage.record':
                        continue
                    u = d.get('usage') or {}
                    t = (d.get('time') or 0) / 1000
                    if t < since:
                        continue
                    agg['input'] += u.get('inputOther') or 0
                    agg['output'] += u.get('output') or 0
                    agg['cache_read'] += u.get('inputCacheRead') or 0
                    agg['cache_creation'] += u.get('inputCacheCreation') or 0
                    agg['calls'] += 1
        except Exception:
            continue
    return agg


def fmt(n):
    return f'{n:,}'


def main():
    truth = {
        'claude-code': audit_claude(),
        'codex': audit_codex(),
        'kimi-code': audit_kimi(),
    }
    print(f'== 独立对账（{MODE}，since {datetime.fromtimestamp(since)}）==')
    grand = blank()
    for agent, a in truth.items():
        total = a['input'] + a['output'] + a['cache_read'] + a['cache_creation']
        grand = {k: grand[k] + a[k] for k in grand}
        print(f"{agent:12s}  calls={fmt(a['calls']):>8}  total={fmt(total):>14}  "
              f"in={fmt(a['input'])}  out={fmt(a['output'])}  cr={fmt(a['cache_read'])}  cw={fmt(a['cache_creation'])}")
    gt = grand['input'] + grand['output'] + grand['cache_read'] + grand['cache_creation']
    print(f"{'TOTAL':12s}  calls={fmt(grand['calls']):>8}  total={fmt(gt):>14}")
    print()
    print('拿这组数字对比：token-pilot month 的「按宿主」tokens/次数（应逐项相等）')


if __name__ == '__main__':
    main()
