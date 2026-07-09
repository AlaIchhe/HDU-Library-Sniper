"""方向键菜单（Windows 真实终端）+ 非交互回退。"""

from __future__ import annotations

import sys

from cli.prompts import _interactive_tty, input_int


def select_menu(title: str, options: list[str], default: int = 0) -> int:
    """方向键 ↑/↓ 选择，Enter 确认，返回选中项索引。

    非交互式环境（管道输入、非 Windows 等）自动回退为数字输入。
    """
    if not options:
        raise ValueError("选项列表不能为空")
    if not _interactive_tty():
        return _select_menu_fallback(title, options, default)

    import msvcrt

    idx = default % len(options)
    lines_printed = 0

    def render(first: bool = False) -> None:
        nonlocal lines_printed
        if not first:
            sys.stdout.write(f"\x1b[{lines_printed}A")
        rows = [title, ""]
        for i, opt in enumerate(options):
            cursor = "> " if i == idx else "  "
            rows.append(f"{cursor}{opt}")
        rows.append("")
        rows.append("(方向键 ↑/↓ 选择，Enter 确认)")
        for row in rows:
            sys.stdout.write("\x1b[2K" + row + "\n")
        sys.stdout.flush()
        lines_printed = len(rows)

    render(first=True)
    while True:
        key = msvcrt.getch()
        if key in (b"\xe0", b"\x00"):
            key2 = msvcrt.getch()
            if key2 == b"H":
                idx = (idx - 1) % len(options)
                render()
            elif key2 == b"P":
                idx = (idx + 1) % len(options)
                render()
        elif key in (b"\r", b"\n"):
            return idx
        elif key == b"\x03":
            raise KeyboardInterrupt


def _select_menu_fallback(title: str, options: list[str], default: int = 0) -> int:
    print(title)
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    return input_int(f"选择 [1-{len(options)}]", 1, len(options), default=default + 1) - 1


def multi_select_menu(title: str, options: list[str]) -> list[int]:
    """方向键 ↑/↓ 移动，空格勾选/取消，A 全选/取消全选，Enter 确认。返回选中项索引列表。"""
    if not options:
        return []
    if not _interactive_tty():
        return _multi_select_fallback(title, options)

    import msvcrt

    idx = 0
    selected: set[int] = set()
    lines_printed = 0

    def render(first: bool = False) -> None:
        nonlocal lines_printed
        if not first:
            sys.stdout.write(f"\x1b[{lines_printed}A")
        rows = [title, ""]
        for i, opt in enumerate(options):
            cursor = "> " if i == idx else "  "
            box = "[x]" if i in selected else "[ ]"
            rows.append(f"{cursor}{box} {opt}")
        rows.append("")
        rows.append("(↑/↓ 移动，空格 勾选/取消，A 全选/取消全选，Enter 确认)")
        for row in rows:
            sys.stdout.write("\x1b[2K" + row + "\n")
        sys.stdout.flush()
        lines_printed = len(rows)

    render(first=True)
    while True:
        key = msvcrt.getch()
        if key in (b"\xe0", b"\x00"):
            key2 = msvcrt.getch()
            if key2 == b"H":
                idx = (idx - 1) % len(options)
                render()
            elif key2 == b"P":
                idx = (idx + 1) % len(options)
                render()
        elif key == b" ":
            if idx in selected:
                selected.discard(idx)
            else:
                selected.add(idx)
            render()
        elif key in (b"a", b"A"):
            selected = set() if len(selected) == len(options) else set(range(len(options)))
            render()
        elif key in (b"\r", b"\n"):
            return sorted(selected)
        elif key == b"\x03":
            raise KeyboardInterrupt


def _multi_select_fallback(title: str, options: list[str]) -> list[int]:
    print(title)
    for i, opt in enumerate(options, 1):
        print(f"  {i}. {opt}")
    sel = input("输入序号（多个用逗号分隔，all=全部，留空=取消）: ").strip()
    if not sel:
        return []
    if sel.lower() == "all":
        return list(range(len(options)))
    try:
        indices = [int(x.strip()) - 1 for x in sel.split(",")]
    except ValueError:
        return []
    return sorted({i for i in indices if 0 <= i < len(options)})


def confirm(prompt: str, default: bool = True) -> bool:
    """方向键选择 是/否，回车确认。"""
    idx = select_menu(prompt, ["是", "否"], default=0 if default else 1)
    return idx == 0
