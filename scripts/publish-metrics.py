#!/usr/bin/env python3
"""GitHub 侧发布数据回流采集器。

解决「发了不知道效果」——把发布后真正能指导决策的数字抓下来，按天追加成时间序列。

为什么只做 GitHub：
  - 唯一一个数据完全开放、有官方 API、不需要登录态的平台
  - 你的两个项目最终价值都落在 star 上，不是阅读量
  - 内容平台（知乎/公众号）的阅读量 Easel 自己能抓，这边不重复造

用法：
    python3 scripts/publish-metrics.py                # 采集并追加
    python3 scripts/publish-metrics.py --dry-run      # 只打印不写文件
    python3 scripts/publish-metrics.py --report       # 只看历史趋势，不采集
    python3 scripts/publish-metrics.py --repos owner/a,owner/b

产出：docs/publish/data/github-log.jsonl（每行一个 JSON 快照，按天去重）
      该路径被 .gitignore 排除（docs/*），数据只留在本机，不进公开仓库。
      换位置：PUBLISH_METRICS_LOG=/abs/path/github-log.jsonl python3 scripts/publish-metrics.py

依赖：gh（已登录）或 GITHUB_TOKEN；其余只用 Python 标准库。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
# 数据不进公开仓库（仓库 .gitignore 排除 docs/*）。
# 需要换位置时用环境变量 PUBLISH_METRICS_LOG 指定绝对路径。
LOG_PATH = Path(
    os.environ.get("PUBLISH_METRICS_LOG")
    or (ROOT / "docs" / "publish" / "data" / "github-log.jsonl")
)

# 仓库 → npm 包名（没有 npm 包就写 None）
DEFAULT_REPOS = {
    "anthonyhann/token-pilot": "@anthonyhan/token-pilot",
    "anthonyhann/chinese-history": None,
}


# ── gh 调用 ────────────────────────────────────────────────────────────────

def gh_api(path: str) -> dict | None:
    """调 GitHub API。失败返回 None 而不是抛异常——某项拿不到不该让整次采集失败。"""
    try:
        out = subprocess.run(
            ["gh", "api", path],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            # traffic 接口需要 push 权限，403 是预期内的失败
            if "403" in out.stderr or "404" in out.stderr:
                return None
            print(f"  ⚠️  gh api {path} 失败: {out.stderr.strip()[:120]}", file=sys.stderr)
            return None
        return json.loads(out.stdout)
    except Exception as e:
        print(f"  ⚠️  gh api {path} 异常: {e}", file=sys.stderr)
        return None


def npm_downloads(pkg: str) -> int | None:
    """npm 周下载量。注意 npm 的 point 接口数据有延迟，stale 时照实记录。"""
    try:
        url = f"https://api.npmjs.org/downloads/point/last-week/{pkg}"
        with urlopen(Request(url, headers={"User-Agent": "token-pilot-metrics"}), timeout=20) as r:
            d = json.loads(r.read().decode())
        return int(d.get("downloads") or 0)
    except Exception:
        return None


# ── 采集 ──────────────────────────────────────────────────────────────────

def collect_one(slug: str, npm_pkg: str | None) -> dict:
    """采一个仓库。缺项一律记 None，不猜。"""
    row: dict = {"repo": slug}

    basic = gh_api(f"repos/{slug}")
    if basic:
        row["stars"] = basic.get("stargazers_count")
        row["forks"] = basic.get("forks_count")
        row["watchers"] = basic.get("subscribers_count")
        row["open_issues"] = basic.get("open_issues_count")
    else:
        row.update({"stars": None, "forks": None, "watchers": None, "open_issues": None})

    clones = gh_api(f"repos/{slug}/traffic/clones")
    row["clones_14d"] = clones.get("count") if clones else None
    row["clones_uniques_14d"] = clones.get("uniques") if clones else None

    views = gh_api(f"repos/{slug}/traffic/views")
    row["views_14d"] = views.get("count") if views else None
    row["views_uniques_14d"] = views.get("uniques") if views else None

    if npm_pkg:
        row["npm_pkg"] = npm_pkg
        row["npm_downloads_7d"] = npm_downloads(npm_pkg)
    return row


def collect(repos: dict[str, str | None]) -> dict:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"\n📊 采集 {today}")
    rows = []
    for slug, pkg in repos.items():
        print(f"  → {slug}")
        r = collect_one(slug, pkg)
        rows.append(r)
        print(
            f"     ⭐ {r['stars']}  fork {r['forks']}  "
            f"clone(14d) {r['clones_uniques_14d']}  view(14d) {r['views_uniques_14d']}"
            + (f"  npm(7d) {r['npm_downloads_7d']}" if pkg else "")
        )
    return {"date": today, "collected_at": datetime.now(timezone.utc).isoformat(), "repos": rows}


# ── 存储 ──────────────────────────────────────────────────────────────────

def append_snapshot(snap: dict) -> bool:
    """追加一行。同一天已有记录则替换（重跑不产生重复行）。"""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if LOG_PATH.exists():
        for line in LOG_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                if json.loads(line).get("date") == snap["date"]:
                    continue  # 丢掉同日的旧记录
            except json.JSONDecodeError:
                continue
            lines.append(line)
    lines.append(json.dumps(snap, ensure_ascii=False))
    LOG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def load_history() -> list[dict]:
    if not LOG_PATH.exists():
        return []
    out = []
    for line in LOG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return sorted(out, key=lambda x: x.get("date", ""))


# ── 报告 ──────────────────────────────────────────────────────────────────

def report() -> None:
    hist = load_history()
    if not hist:
        print("还没有历史数据。先跑一次采集：python3 scripts/publish-metrics.py")
        return

    print(f"\n📈 历史趋势（{len(hist)} 天，{hist[0]['date']} → {hist[-1]['date']}）")

    # 按仓库聚合
    by_repo: dict[str, list[tuple[str, dict]]] = {}
    for snap in hist:
        for r in snap.get("repos", []):
            by_repo.setdefault(r["repo"], []).append((snap["date"], r))

    for slug, rows in by_repo.items():
        print(f"\n── {slug}")
        first_d, first = rows[0]
        last_d, last = rows[-1]

        def delta(key: str) -> str:
            a, b = first.get(key), last.get(key)
            if a is None or b is None:
                return "—"
            d = b - a
            return f"{a} → {b} ({'+' if d >= 0 else ''}{d})"

        print(f"   ⭐ stars:      {delta('stars')}")
        print(f"   🍴 forks:      {delta('forks')}")
        print(f"   👁  浏览(14d):  {last.get('views_uniques_14d', '—')} unique")
        print(f"   📥 克隆(14d):   {last.get('clones_uniques_14d', '—')} unique")
        if last.get("npm_pkg"):
            print(f"   📦 npm(7d):    {last.get('npm_downloads_7d', '—')}")

        # 转化率：star 增量 vs 浏览增量
        s0, s1 = first.get("stars"), last.get("stars")
        if s0 is not None and s1 is not None and len(rows) > 1:
            gained = s1 - s0
            if gained > 0:
                print(f"   📊 本周期净增 {gained} star")
            elif gained == 0:
                print(f"   ⚠️  本周期 star 无增长 —— 若已发布内容，说明选题或受众不匹配，换选题而非加平台")
            else:
                print(f"   🔻 star 减少 {abs(gained)}")

    print(f"\n明细文件：{LOG_PATH.relative_to(ROOT)}")


# ── 入口 ──────────────────────────────────────────────────────────────────

def main() -> int:
    args = sys.argv[1:]

    if "--report" in args:
        report()
        return 0

    repos = dict(DEFAULT_REPOS)
    for a in args:
        if a.startswith("--repos="):
            items = a.split("=", 1)[1].split(",")
            repos = {s.strip(): repos.get(s.strip()) for s in items if s.strip()}

    snap = collect(repos)

    if "--dry-run" in args:
        print("\n[dry-run] 不写文件，内容如下：")
        print(json.dumps(snap, ensure_ascii=False, indent=2))
        return 0

    append_snapshot(snap)
    print(f"\n✅ 已追加到 {LOG_PATH.relative_to(ROOT)}")
    print("   看趋势：python3 scripts/publish-metrics.py --report")
    return 0


if __name__ == "__main__":
    sys.exit(main())
