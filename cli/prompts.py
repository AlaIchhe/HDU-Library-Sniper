"""终端输入与格式化工具（纯函数，无业务依赖）。"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timedelta

from utils.time_sync import now_cst


def clear_screen() -> None:
    subprocess.run(["cmd", "/c", "cls"] if os.name == "nt" else ["clear"], check=False, shell=False)


def _interactive_tty() -> bool:
    """是否可以使用方向键交互（Windows + 真实终端）。"""
    return os.name == "nt" and sys.stdin.isatty() and sys.stdout.isatty()


def input_int(prompt: str, lo: int, hi: int, default: int | None = None) -> int:
    hint = f" [{default}]" if default is not None else ""
    while True:
        raw = input(f"{prompt}{hint}: ").strip()
        if not raw and default is not None:
            return default
        try:
            n = int(raw)
            if lo <= n <= hi:
                return n
            print(f"  请输入 {lo}-{hi} 之间的数字")
        except ValueError:
            print("  请输入有效数字")


def input_float(prompt: str, default: float, is_int: bool = False) -> float:
    """留空则返回 default；否则要求输入正数（>0）。"""
    while True:
        raw = input(f"{prompt}: ").strip()
        if not raw:
            return default
        try:
            value = float(raw)
            if value <= 0:
                print("  请输入大于 0 的数字")
                continue
            return int(value) if is_int else value
        except ValueError:
            print("  请输入有效数字")


def parse_execute_time(text: str) -> datetime | None:
    text = text.strip()
    if not text:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(text, fmt).time()
            break
        except ValueError:
            parsed = None
    else:
        raise ValueError("时间格式应为 HH:MM 或 HH:MM:SS")
    now = now_cst()
    target = now.replace(hour=parsed.hour, minute=parsed.minute, second=parsed.second, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def format_countdown(seconds: int) -> str:
    if seconds >= 3600:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"
    m, s = divmod(seconds, 60)
    return f"{m:02d}:{s:02d}"
