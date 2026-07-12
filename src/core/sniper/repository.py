"""基于 YAML 文件的预约方案持久化。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import yaml

from core.sniper.plan import BookingPlan, PlanStatus


class PlanRepository:
    """基于 YAML 文件的方案存储。"""

    def __init__(self, file_path: str | Path) -> None:
        self._file = Path(file_path)
        if not self._file.is_absolute():
            raise ValueError(f"方案路径必须是绝对路径: {self._file}")
        self._cache: list[BookingPlan] | None = None

    def load_all(self) -> list[BookingPlan]:
        if self._cache is not None:
            return list(self._cache)
        if not self._file.exists():
            self._cache = []
            return []
        raw_text = self._file.read_text(encoding="utf-8").strip()
        data = yaml.safe_load(raw_text) if raw_text else None
        if not isinstance(data, list):
            self._cache = []
            return []
        plans = [BookingPlan.from_dict(item) for item in data if isinstance(item, dict)]
        self._cache = plans
        return list(plans)

    def save_all(self, plans: list[BookingPlan]) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        raw = [p.to_dict() for p in plans]
        temporary_file = self._file.with_suffix(f"{self._file.suffix}.tmp")
        temporary_file.write_text(
            yaml.dump(raw, allow_unicode=True, encoding="utf-8").decode("utf-8"),
            encoding="utf-8",
        )
        temporary_file.replace(self._file)
        self._cache = list(plans)

    def add(self, plan: BookingPlan) -> None:
        plans = self.load_all()
        if not plan.plan_id:
            plan.plan_id = uuid.uuid4().hex[:12]
        if not plan.created_at:
            plan.created_at = datetime.now(UTC).isoformat()
        plans.append(plan)
        self.save_all(plans)

    def remove_many(self, plan_ids: list[str]) -> int:
        plans = self.load_all()
        before = len(plans)
        plans = [p for p in plans if p.plan_id not in plan_ids]
        removed = before - len(plans)
        if removed:
            self.save_all(plans)
        return removed

    def batch_set_time(
        self,
        plan_ids: list[str],
        start_hour: int | None = None,
        duration_hours: int | None = None,
        book_days: int | None = None,
    ) -> int:
        plans = self.load_all()
        modified = 0
        for p in plans:
            if p.plan_id in plan_ids:
                if start_hour is not None:
                    p.start_hour = start_hour
                if duration_hours is not None:
                    p.duration_hours = duration_hours
                if book_days is not None:
                    p.book_days = book_days
                modified += 1
        if modified:
            self.save_all(plans)
        return modified

    def list_enabled(self) -> list[BookingPlan]:
        return [p for p in self.load_all() if p.status == PlanStatus.ENABLED]
