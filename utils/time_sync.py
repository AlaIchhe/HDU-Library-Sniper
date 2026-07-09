"""时间工具：预约开始时间、执行时间和座位查询参考时间。"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

CST = ZoneInfo("Asia/Shanghai")


def now_cst() -> datetime:
    """返回当前北京时间。"""
    return datetime.now(CST)


def build_begin_time(start_hour: int, book_days: int = 0) -> datetime:
    """根据开始小时和偏移天数构建预约开始时间。"""
    now = now_cst()
    return (now + timedelta(days=book_days)).replace(
        hour=start_hour, minute=0, second=0, microsecond=0
    )


def get_seat_lookup_time(now: datetime | None = None) -> datetime:
    """返回查询座位图时使用的参考时间。

    慧图接口在闭馆/跨天附近更适合用早上 08:00 查询：
    - 22:00 后查次日 08:00；
    - 07:00 前查当日 08:00；
    - 其他时间用当前时间。
    """
    current = now or now_cst()
    if current.tzinfo is None:
        current = current.replace(tzinfo=CST)
    if current.hour >= 22:
        return (current + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)
    if current.hour < 7:
        return current.replace(hour=8, minute=0, second=0, microsecond=0)
    return current
