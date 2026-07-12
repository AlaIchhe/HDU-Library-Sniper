"""预约方案模型。"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


class PlanStatus:
    ENABLED = "enabled"
    DISABLED = "disabled"


@dataclass
class BookingPlan:
    """一次预约的完整参数集合。"""

    room_type: int
    floor_id: int
    seat_num: str
    start_hour: int
    duration_hours: int
    booker_name: str = ""
    book_days: int = 0
    status: str = PlanStatus.ENABLED
    room_query: str = ""
    plan_id: str | None = None
    created_at: str | None = None

    def validate(self) -> list[str]:
        """校验方案参数，返回错误列表（空列表表示通过）。"""
        errors = []
        if self.room_type not in (1, 2, 3, 4):
            errors.append(f"无效的房间类型：{self.room_type}")
        if self.floor_id <= 0:
            errors.append(f"无效的楼层 ID：{self.floor_id}")
        if not str(self.seat_num).strip():
            errors.append("座位号不能为空")
        if not (0 <= self.start_hour <= 23):
            errors.append(f"开始小时超出范围：{self.start_hour}")
        if self.duration_hours <= 0:
            errors.append(f"时长必须为正数：{self.duration_hours}")
        if self.book_days < 0:
            errors.append(f"天数偏移不能为负：{self.book_days}")
        return errors

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BookingPlan:
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)

    def to_plan_code(self) -> str:
        return f"{self.room_type}:{self.floor_id}:{self.seat_num}:{self.start_hour}:{self.duration_hours}"

    @property
    def enabled(self) -> bool:
        """兼容属性：判断方案是否启用。"""
        return self.status == PlanStatus.ENABLED


@dataclass
class BookingResult:
    """一次预约尝试的结果。"""

    plan: BookingPlan
    success: bool = False
    message: str = ""
    raw_response: dict[str, Any] | None = None
