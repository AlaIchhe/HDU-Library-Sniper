"""房间 / 楼层 / 座位领域查询：浏览选房与抢座编排共用的唯一解析入口。

响应结构解析（魔法路径）统一委托 ``library.responses`` 访问器；本模块只在
领域层把"楼层/座位"组合成 ``FloorInfo`` 或定位特定座位，不再重复遍历
``seatMap.info.id`` / ``POIs[].title``。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from hdu_sniper.booking.time import build_begin_time, planning_lookup_times
from hdu_sniper.library import responses
from hdu_sniper.library.client import (
    ROOM_TYPE_MAP,
    HduLibraryError,
    LibraryClient,
    SeatQueryError,
)


if TYPE_CHECKING:
    # 仅类型注解用；运行期不依赖抢座编排包，避免循环导入。
    from hdu_sniper.booking.models import BookingPlan


@dataclass
class FloorInfo:
    """单个楼层的结构化信息。"""

    floor_id: str
    room_name: str
    seat_count: int
    seat_titles: list[str]


class LibraryRooms:
    """慧图房间类型 / 楼层座位布局查询的唯一归属。

    浏览（``list_floors``，合并今天至后天的布局）与抢座
    （``get_floors_for_booking``，按预约 ``build_begin_time`` 查询）共享同一
    ``_load_seat_map`` 解析路径，消除原与 ``Sniper._resolve_floors`` 的重复。
    """

    def __init__(self, client: LibraryClient) -> None:
        self.client = client

    def list_room_types(self) -> list[dict]:
        """获取所有可用房间类型（透传 client）。"""
        return self.client.get_room_types()

    def _load_seat_map(
        self,
        room_query: str,
        lookup_time: Any,
        duration_hours: int,
    ) -> list[dict[str, Any]]:
        """公共解析：room_query -> detail.space_category -> cat_id/con_id -> seat_map。

        字段契约见 ``responses.space_category_id`` / ``responses.space_category_content_id``
        / ``responses.floors_from_response``（sample: room_detail.json / seat_map.json）。
        """
        detail = self.client.get_room_detail(room_query)
        return self.client.get_seat_map(
            responses.space_category_id(detail),
            responses.space_category_content_id(detail),
            lookup_time,
            duration_hours,
        )

    def list_floors(self, room_query: str) -> list[FloorInfo]:
        """合并今天、明天、后天的楼层和座位，避免当天状态阻止创建方案。"""
        merged: dict[str, tuple[str, set[str]]] = {}
        failures: list[str] = []
        successful_queries = 0
        for lookup_time in planning_lookup_times():
            try:
                floors = self._load_seat_map(room_query, lookup_time, 1)
            except HduLibraryError as exc:
                failures.append(f"{lookup_time.date()}: {exc}")
                continue
            successful_queries += 1
            for floor in floors:
                floor_id = responses.floor_id(floor)
                room_name = responses.floor_name(floor)
                titles = {
                    title
                    for title in (
                        responses.seat_title(seat) for seat in responses.floor_seats(floor)
                    )
                    if title
                }
                if floor_id in merged:
                    merged[floor_id][1].update(titles)
                else:
                    merged[floor_id] = (room_name, titles)

        if successful_queries == 0:
            details = "; ".join(failures)
            raise HduLibraryError(f"今天至后天的座位布局均查询失败: {details}")

        return [
            FloorInfo(
                floor_id=floor_id,
                room_name=room_name,
                seat_count=len(titles),
                seat_titles=sorted(titles),
            )
            for floor_id, (room_name, titles) in merged.items()
        ]

    def resolve_room_query(self, plan: BookingPlan) -> str:
        """方案 -> 房间查询串。

        ``plan.room_query`` 非空直接用；否则按 ``room_type`` 匹配房间类型名。
        返回解析结果，不修改 plan（原 Sniper 在此处隐式 mutate ``plan.room_query``
        且不写回仓库——移除后无额外开销，反而消除副作用）。
        """
        if plan.room_query:
            return plan.room_query

        room_types = self.client.get_room_types()
        target_name = ROOM_TYPE_MAP.get(str(plan.room_type), "")
        matched = [r for r in room_types if r.get("name") == target_name]
        if matched:
            return str(matched[0]["query"])

        if not room_types:
            raise HduLibraryError("无可用房间类型")
        available = ", ".join(r.get("name", "?") for r in room_types)
        raise HduLibraryError(f"未找到匹配的房间类型: 期望 '{target_name}', 可用: [{available}]")

    def get_floors_for_booking(self, plan: BookingPlan) -> list[dict[str, Any]]:
        """定位方案对应的楼层座位数据（抢座编排用，按预约开始时间查询）。"""
        return self._load_seat_map(
            self.resolve_room_query(plan),
            build_begin_time(plan.start_hour),
            plan.duration_hours,
        )

    def find_seat(
        self,
        floors: list[dict[str, Any]],
        floor_id: str | int,
        seat_num: str | int,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """在楼层列表中定位指定楼层和座位号。

        楼层匹配 ``responses.floor_id``（= ``seatMap.info.id``）；座位匹配
        ``responses.seat_title``（= ``seatMap.POIs[].title`` = 座位号），返回的座位
        ``id`` 由调用方经 ``responses.seat_id`` 取作 ``bookSeats`` 的 ``seats[0]``。
        """
        floor_id = str(floor_id)
        seat_num = str(seat_num)
        floor_names: list[str] = []
        target_floor = None

        for item in floors:
            fid = responses.floor_id(item)
            floor_names.append(f"{responses.floor_name(item)}={fid}")
            if fid == floor_id:
                target_floor = item
                break

        if not target_floor:
            raise SeatQueryError(f"找不到楼层 id={floor_id}。可用楼层：{', '.join(floor_names)}")

        seats = responses.floor_seats(target_floor)
        matches = [seat for seat in seats if responses.seat_title(seat) == seat_num]
        if not matches:
            raise SeatQueryError(f"{responses.floor_name(target_floor)} 中找不到 {seat_num} 座")
        if len(matches) > 1:
            raise SeatQueryError(f"{responses.floor_name(target_floor)} 中存在多个 {seat_num} 座")
        return target_floor, matches[0]

    @staticmethod
    def resolve_room_type(name: str) -> int | None:
        """房间类型名 -> 编号（1=自习室 …）；无法识别返回 None。"""
        for num, label in ROOM_TYPE_MAP.items():
            if label in name:
                return int(num)
        return None
