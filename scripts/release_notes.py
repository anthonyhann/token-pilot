#!/usr/bin/env python3
"""从 RELEASE_NOTES.md 抽出指定版本的发布说明，并剥成纯文本。

为什么单独成脚本：更新弹窗和托盘提示都是纯文本渲染，不剥 Markdown
用户就会看到字面的 **加粗**、`代码`、[链接](url)。v0.4.1 就踩过这个坑。
逻辑放在 CI 的 heredoc 里没法单测，一改就可能坑到发版，所以抽出来。

用法：
  python3 scripts/release_notes.py 0.4.1        # 打印纯文本说明
  python3 scripts/release_notes.py 0.4.1 --raw  # 打印原始 Markdown 段落
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTES_PATH = ROOT / 'RELEASE_NOTES.md'


def strip_md(s: str) -> str:
    """剥掉 Markdown 标记但保留内容，供纯文本渲染。"""
    # 代码块围栏
    s = re.sub(r'^```.*$', '', s, flags=re.M)
    # 图片 → 替代文字
    s = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', s)
    # 链接 [文字](url) → 文字 (url)：纯文本里地址仍可复制，比只剩文字有用
    s = re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', r'\1 (\2)', s)
    # 加粗 → 斜体 → 删除线 → 行内代码，只剥标记。
    # DOTALL：加粗常跨行，不跨行匹配会漏一半标记。
    s = re.sub(r'(\*\*\*|___)(.+?)\1', r'\2', s, flags=re.S)
    s = re.sub(r'(\*\*|__)(.+?)\1', r'\2', s, flags=re.S)
    s = re.sub(r'(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])', r'\1', s, flags=re.S)
    # **_x_** 剥掉双下划线后剩 _x_，再收一遍；保护 snake_case
    s = re.sub(r'(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])', r'\1', s, flags=re.S)
    s = re.sub(r'~~(.+?)~~', r'\1', s, flags=re.S)
    s = re.sub(r'`([^`]+)`', r'\1', s)
    # 行首标记：标题 #、引用 >、列表符 * + 统一为 -
    s = re.sub(r'^\s{0,3}#{1,6}\s+', '', s, flags=re.M)
    s = re.sub(r'^\s{0,3}>\s?', '', s, flags=re.M)
    s = re.sub(r'^(\s*)[*+]\s+', r'\1- ', s, flags=re.M)
    # 折叠多余空行
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def extract(version: str, raw: bool = False) -> str:
    """取出 `## v<version>` 段落。只认行首标题，避免匹配到文件头里的示例。"""
    txt = NOTES_PATH.read_text(encoding='utf-8')
    m = re.search(rf'^## v{re.escape(version)}\s*$', txt, re.M)
    if not m:
        raise SystemExit(f'RELEASE_NOTES.md 里找不到「## v{version}」段落')
    rest = txt[m.end():]
    nxt = re.search(r'^## v\S+\s*$', rest, re.M)
    body = (rest[:nxt.start()] if nxt else rest).strip().strip('-').strip()
    if not body:
        raise SystemExit(f'RELEASE_NOTES.md 的「## v{version}」段落是空的')
    return body if raw else strip_md(body)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print(__doc__)
        raise SystemExit(2)
    version = args[0].lstrip('v')
    out = extract(version, raw='--raw' in sys.argv)
    print(out)
    # 剥完自检：不该再残留成对的行内标记
    if '--raw' not in sys.argv:
        residue = re.search(r'\*\*|`[^`\n]+`|\[[^\]]+\]\([^)]*\)', out)
        if residue:
            raise SystemExit(f'剥 Markdown 后仍有残留：{residue.group(0)}')


if __name__ == '__main__':
    main()
