"""预约日期策略：一周七天规则、持久化与执行门控。

系统任务保持每天 20:00 唤起，由本模块判断目标预约日（后天）是否落在
用户勾选的星期内，以及自动预约是否被暂停。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from pathlib import Path

import yaml

from hdu_sniper.booking.time import BOOKING_DAY_OFFSET, CST


SCHEMA_VERSION = 1
ALL_WEEKDAYS = (1, 2, 3, 4, 5, 6, 7)
WEEKDAY_NAMES = {
    1: "周一",
    2: "周二",
    3: "周三",
    4: "周四",
    5: "周五",
    6: "周六",
    7: "周日",
}


class SchedulePolicyError(ValueError):
    """星期规则不合法。"""


@dataclass(frozen=True)
class SchedulePolicy:
    """每周预约星期规则。"""

    enabled: bool
    weekdays: frozenset[int]
    corrupt: bool = False

    def __post_init__(self) -> None:
        if self.corrupt:
            return
        if not self.weekdays:
            raise SchedulePolicyError("至少需要选择一个星期")
        if not self.weekdays.issubset(ALL_WEEKDAYS):
            raise SchedulePolicyError(f"星期必须位于 {ALL_WEEKDAYS} 范围内")

    @classmethod
    def default(cls) -> SchedulePolicy:
        """旧用户无配置文件时的兼容默认值：每天、启用。"""
        return cls(enabled=True, weekdays=frozenset(ALL_WEEKDAYS))

    def summary_label(self) -> str:
        """返回界面摘要：每天 / 工作日 / 周末 / 具体星期组合。"""
        days = sorted(self.weekdays)
        if days == [1, 2, 3, 4, 5, 6, 7]:
            return "每天"
        if days == [1, 2, 3, 4, 5]:
            return "工作日"
        if days == [6, 7]:
            return "周末"
        return "、".join(WEEKDAY_NAMES[day] for day in days)

    def evaluate(self, booking_date: date) -> tuple[bool, str | None]:
        """判断目标预约日是否应执行。

        Returns:
            (是否执行, 跳过原因)；原因只用于审计日志，不外发。
        """
        if not self.enabled:
            return False, "paused"
        if booking_date.isoweekday() not in self.weekdays:
            return False, "weekday_mismatch"
        return True, None

    def next_booking_date(self, from_date: date, horizon: int = 90) -> date | None:
        """查找下一个符合规则的预约日期；最早为 from_date 后天。"""
        if not self.enabled:
            return None
        start = from_date + timedelta(days=BOOKING_DAY_OFFSET)
        for offset in range(horizon):
            candidate = start + timedelta(days=offset)
            if candidate.isoweekday() in self.weekdays:
                return candidate
        return None

    def to_mapping(self) -> dict[str, object]:
        """转换为可持久化的字典。"""
        return {
            "schema_version": SCHEMA_VERSION,
            "enabled": self.enabled,
            "weekdays": sorted(self.weekdays),
            "updated_at": datetime.now(CST).isoformat(timespec="seconds"),
        }

    def save(self, path: Path) -> None:
        """原子写入策略文件：先写临时文件再替换，避免留下半份配置。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            yaml.safe_dump(self.to_mapping(), allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        temporary.replace(path)

    def with_updates(
        self,
        *,
        enabled: bool | None = None,
        weekdays: list[int] | None = None,
    ) -> SchedulePolicy:
        """返回应用了部分更新的新策略，同时清除损坏标记。"""
        return replace(
            self,
            enabled=self.enabled if enabled is None else enabled,
            weekdays=self.weekdays if weekdays is None else frozenset(weekdays),
            corrupt=False,
        )

    @classmethod
    def load(cls, path: Path) -> SchedulePolicy:
        """读取策略；文件缺失返回兼容默认值，损坏时安全暂停。"""
        if not path.exists():
            return cls.default()
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            return cls(enabled=False, weekdays=frozenset(), corrupt=True)
        if not isinstance(raw, dict):
            return cls(enabled=False, weekdays=frozenset(), corrupt=True)
        enabled = raw.get("enabled", True)
        weekdays = raw.get("weekdays")
        if not isinstance(enabled, bool) or not isinstance(weekdays, list):
            return cls(enabled=False, weekdays=frozenset(), corrupt=True)
        try:
            return cls(enabled=enabled, weekdays=frozenset(int(day) for day in weekdays))
        except (SchedulePolicyError, TypeError, ValueError):
            return cls(enabled=False, weekdays=frozenset(), corrupt=True)
