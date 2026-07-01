"""时间工具：预约开始时间、执行时间和座位查询参考时间。"""

from __future__ import annotations

from datetime import datetime, time, timedelta
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


def parse_plan_code(plan_text: str) -> dict[str, int | str]:
    """解析 ``roomType:floorId:seatNum:startHour:durationHours`` 计划码。"""
    try:
        room_type, floor_id, seat_num, start_hour, duration_hours = plan_text.split(":")
        return {
            "room_type": int(room_type),
            "floor_id": int(floor_id),
            "seat_num": str(seat_num),
            "start_hour": int(start_hour),
            "duration_hours": int(duration_hours),
        }
    except Exception as exc:
        raise ValueError("plan 格式应为 roomType:floorId:seatNum:startHour:durationHours") from exc


def parse_execute_time(execute_at_str: str) -> time | None:
    """解析 ``HH:MM`` 或 ``HH:MM:SS`` 执行时间。"""
    text = str(execute_at_str or "").strip()
    if not text:
        return None
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            pass
    raise ValueError("execute_at 格式应为 HH:MM 或 HH:MM:SS")


def build_execute_datetime(execute_at_str: str, now: datetime | None = None) -> datetime | None:
    """构建下一次执行时间；如果今天已过，自动推迟到明天。"""
    parsed = parse_execute_time(execute_at_str)
    if parsed is None:
        return None
    now = now or now_cst()
    if now.tzinfo is None:
        now = now.replace(tzinfo=CST)
    target = now.replace(hour=parsed.hour, minute=parsed.minute, second=parsed.second, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


def normalize_execute_time(value: str) -> str:
    """将执行时间格式化为 ``HH:MM:SS``。"""
    parsed = parse_execute_time(value)
    if parsed is None:
        return ""
    return f"{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}"


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
