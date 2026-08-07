"""与业务时间边界相关的常量，避免高层模块互相循环导入。"""

from __future__ import annotations

from zoneinfo import ZoneInfo


CST = ZoneInfo("Asia/Shanghai")
BOOKING_DAY_OFFSET = 2
PLANNING_LOOKAHEAD_DAYS = (0, 1, 2)
