"""预约方案的创建、查询和 YAML 持久化。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from hdu_sniper.booking.models import BookingPlan, PlanStatus
from hdu_sniper.library.client import LibraryClient
from hdu_sniper.library.rooms import FloorInfo, LibraryRooms


class BookingPlans:
    """管理预约方案及其文件存储。"""

    def __init__(
        self,
        file_path: str | Path,
        client: LibraryClient,
        rooms: LibraryRooms,
    ) -> None:
        self._file = Path(file_path)
        if not self._file.is_absolute():
            raise ValueError(f"方案路径必须是绝对路径: {self._file}")
        self.client = client
        self.rooms = rooms
        self._cache: list[BookingPlan] | None = None

    def list_room_types(self) -> list[dict[str, Any]]:
        return self.rooms.list_room_types()

    def list_floors(self, room_query: str) -> list[FloorInfo]:
        return self.rooms.list_floors(room_query)

    def list_all(self) -> list[BookingPlan]:
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
        self._cache = [BookingPlan.from_dict(item) for item in data if isinstance(item, dict)]
        return list(self._cache)

    def list_enabled(self) -> list[BookingPlan]:
        return [plan for plan in self.list_all() if plan.status == PlanStatus.ENABLED]

    def save_all(self, plans: list[BookingPlan]) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        temporary_file = self._file.with_suffix(f"{self._file.suffix}.tmp")
        temporary_file.write_text(
            yaml.dump(
                [plan.to_dict() for plan in plans],
                allow_unicode=True,
                encoding="utf-8",
            ).decode("utf-8"),
            encoding="utf-8",
        )
        temporary_file.replace(self._file)
        self._cache = list(plans)

    def add(self, plan: BookingPlan) -> None:
        plans = self.list_all()
        plan.plan_id = plan.plan_id or uuid.uuid4().hex[:12]
        plan.created_at = plan.created_at or datetime.now(UTC).isoformat()
        plans.append(plan)
        self.save_all(plans)

    def delete(self, plan_ids: list[str]) -> int:
        plans = self.list_all()
        retained = [plan for plan in plans if plan.plan_id not in plan_ids]
        removed = len(plans) - len(retained)
        if removed:
            self.save_all(retained)
        return removed

    def update_times(
        self,
        plan_ids: list[str],
        *,
        start_hour: int | None = None,
        duration_hours: int | None = None,
    ) -> int:
        plans = self.list_all()
        modified = 0
        for plan in plans:
            if plan.plan_id not in plan_ids:
                continue
            if start_hour is not None:
                plan.start_hour = start_hour
            if duration_hours is not None:
                plan.duration_hours = duration_hours
            modified += 1
        if modified:
            self.save_all(plans)
        return modified

    def create(
        self,
        *,
        room_type_name: str,
        room_query: str,
        floor_id: int,
        seat_num: str,
        start_hour: int,
        duration_hours: int,
    ) -> tuple[BookingPlan, list[str], bool]:
        room_type = LibraryRooms.resolve_room_type(room_type_name)
        fell_back = room_type is None
        plan = BookingPlan(
            room_type=room_type or 1,
            floor_id=int(floor_id),
            seat_num=seat_num,
            start_hour=start_hour,
            duration_hours=duration_hours,
            booker_name=self.client.name or self.client.uid,
            room_query=room_query,
        )
        errors = plan.validate()
        if not errors:
            self.add(plan)
        return plan, errors, fell_back
