"""固定后天预约时间与三日方案查询时间。"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


CST = ZoneInfo("Asia/Shanghai")
BOOKING_DAY_OFFSET = 2
PLANNING_LOOKAHEAD_DAYS = (0, 1, 2)


def now_cst() -> datetime:
    """返回当前北京时间。"""
    return datetime.now(CST)


def build_begin_time(start_hour: int, now: datetime | None = None) -> datetime:
    """构建后天的预约开始时间；目标日期不可由外部输入改变。"""
    current = now or now_cst()
    if current.tzinfo is None:
        current = current.replace(tzinfo=CST)
    return (current + timedelta(days=BOOKING_DAY_OFFSET)).replace(
        hour=start_hour,
        minute=0,
        second=0,
        microsecond=0,
    )


def planning_lookup_times(now: datetime | None = None) -> tuple[datetime, ...]:
    """返回今天、明天和后天的 08:00，供创建方案时合并座位布局。"""
    current = now or now_cst()
    if current.tzinfo is None:
        current = current.replace(tzinfo=CST)
    base = current.replace(hour=8, minute=0, second=0, microsecond=0)
    return tuple(base + timedelta(days=days) for days in PLANNING_LOOKAHEAD_DAYS)
