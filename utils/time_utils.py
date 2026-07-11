"""时间格式化与解析工具。"""

from __future__ import annotations

from datetime import datetime, timedelta

from utils.time_sync import now_cst


def parse_execute_time(text: str) -> datetime | None:
    """解析用户输入的执行时间（HH:MM 或 HH:MM:SS）。

    如果解析出的时间已过，自动调整到明天。

    Args:
        text: 时间字符串，格式为 HH:MM 或 HH:MM:SS

    Returns:
        解析后的 datetime 对象，如果输入为空则返回 None

    Raises:
        ValueError: 时间格式不正确
    """
    text = text.strip()
    if not text:
        return None

    # 尝试两种格式
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            parsed = datetime.strptime(text, fmt).time()
            break
        except ValueError:
            parsed = None
    else:
        raise ValueError("时间格式应为 HH:MM 或 HH:MM:SS")

    # 构造目标时间
    now = now_cst()
    target = now.replace(
        hour=parsed.hour,
        minute=parsed.minute,
        second=parsed.second,
        microsecond=0
    )

    # 如果已过期，调整到明天
    if target <= now:
        target += timedelta(days=1)

    return target


def format_countdown(seconds: int) -> str:
    """格式化倒计时秒数为 HH:MM:SS 或 MM:SS 格式。

    Args:
        seconds: 倒计时秒数

    Returns:
        格式化的倒计时字符串
    """
    if seconds >= 3600:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"
    m, s = divmod(seconds, 60)
    return f"{m:02d}:{s:02d}"
