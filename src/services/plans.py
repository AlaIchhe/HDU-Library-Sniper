"""方案编排服务：方案 CRUD、创建编排与房间/楼层浏览委托。

把原先散在 CLI handler 里的编排（resolve_room_type 回退、构造 BookingPlan、
校验、持久化）收口于此，使 CLI 只依赖 services，不再直连 core 的编排符号。
纯委托的浏览（list_room_types/list_floors）直接转发 RoomBrowser，不另包一层
——它们本就是无逻辑透传，再包一层只是包装的包装。
"""

from __future__ import annotations

from typing import Any

from core.client import LibraryClient
from core.room_browser import FloorInfo, RoomBrowser
from core.sniper import BookingPlan, PlanRepository


class PlanService:
    """方案管理与房间浏览的编排入口；CRUD + 创建编排统一在此。"""

    def __init__(
        self,
        client: LibraryClient,
        plans: PlanRepository,
        room_browser: RoomBrowser,
    ) -> None:
        self.client = client
        self.plans = plans
        self.room_browser = room_browser

    # ---- 浏览（纯委托 RoomBrowser）----
    def list_room_types(self) -> list[dict[str, Any]]:
        """获取所有可用房间类型（透传 RoomBrowser）。"""
        return self.room_browser.list_room_types()

    def list_floors(self, room_query: str) -> list[FloorInfo]:
        """查询某房间类型下的楼层列表（透传 RoomBrowser）。"""
        return self.room_browser.list_floors(room_query)

    # ---- 方案 CRUD ----
    def list_plans(self) -> list[BookingPlan]:
        return self.plans.load_all()

    def list_enabled(self) -> list[BookingPlan]:
        return self.plans.list_enabled()

    def delete_plans(self, plan_ids: list[str]) -> int:
        return self.plans.remove_many(plan_ids)

    def modify_time(self, plan_ids: list[str], **kwargs) -> int:
        return self.plans.batch_set_time(plan_ids, **kwargs)

    # ---- 创建编排 ----
    def create_plan(
        self,
        *,
        room_type_name: str,
        room_query: str,
        floor_id: int,
        seat_num: str,
        start_hour: int,
        duration_hours: int,
        book_days: int,
    ) -> tuple[BookingPlan, list[str], bool]:
        """构造并持久化方案。

        room_type_name 无法识别时回退 1（自习室）。booker 取 Cookie 认证出的
        账号（服务器要求实际预约用认证账号，booker_name 仅本地方案展示）。

        返回 ``(plan, errors, fell_back)``：errors 非空表示校验失败、未持久化；
        fell_back 表示 room_type_name 未能识别、已回退到自习室（供调用方提示）。
        """
        room_type = RoomBrowser.resolve_room_type(room_type_name)
        fell_back = room_type is None
        if fell_back:
            room_type = 1
        booker = self.client.name or self.client.uid
        plan = BookingPlan(
            room_type=room_type,
            floor_id=int(floor_id),
            seat_num=seat_num,
            start_hour=start_hour,
            duration_hours=duration_hours,
            booker_name=booker,
            book_days=book_days,
            room_query=room_query,
        )
        errors = plan.validate()
        if not errors:
            self.plans.add(plan)
        return plan, errors, fell_back
