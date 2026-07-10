"""房间 / 楼层 / 座位领域查询：浏览选房与抢座编排共用的唯一解析入口。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from core.client import ROOM_TYPE_MAP, HduLibraryError, LibraryClient, SeatQueryError
from utils.time_sync import build_begin_time, get_seat_lookup_time

if TYPE_CHECKING:
    # 仅类型注解用；运行期不依赖抢座编排包，避免循环导入。
    from core.sniper.plan import BookingPlan


@dataclass
class FloorInfo:
    """单个楼层的结构化信息。"""

    floor_id: str
    room_name: str
    seat_count: int
    seat_titles: list[str]


class RoomBrowser:
    """慧图房间类型 / 楼层座位布局查询的唯一归属。

    浏览（``list_floors``，按 ``get_seat_lookup_time`` 查询）与抢座
    （``get_floors_for_booking``，按预约 ``build_begin_time`` 查询）共享同一
    ``_load_seat_map`` 解析路径，消除原与 ``Sniper._resolve_floors`` 的重复。
    """

    def __init__(self, client: LibraryClient) -> None:
        self.client = client

    def list_room_types(self) -> list[dict]:
        """获取所有可用房间类型（透传 client）。"""
        return self.client.get_room_types()

    def _load_seat_map(
        self, room_query: str, lookup_time: Any, duration_hours: int
    ) -> list[dict[str, Any]]:
        """公共解析：room_query -> detail.space_category -> cat_id/con_id -> seat_map。

        字段契约：cat_id / con_id 取自 detail["space_category"]；
        楼层 id 取自 seatMap.info.id；座位号取自 seatMap.POIs[].title。
        """
        detail = self.client.get_room_detail(room_query)
        space = detail["space_category"]
        return self.client.get_seat_map(
            str(space["category_id"]), str(space["content_id"]), lookup_time, duration_hours
        )

    def list_floors(self, room_query: str) -> list[FloorInfo]:
        """查询某房间类型下的楼层列表（含座位数与座位号），供交互式浏览。"""
        floors = self._load_seat_map(room_query, get_seat_lookup_time(), 1)

        result: list[FloorInfo] = []
        for f in floors:
            seatmap = f.get("seatMap", {}) or {}
            info = seatmap.get("info", {}) or {}
            seats = seatmap.get("POIs", []) or []
            titles = sorted(s.get("title", "") for s in seats if s.get("title"))
            result.append(
                FloorInfo(
                    floor_id=str(info.get("id", "")),
                    room_name=f.get("roomName", "?"),
                    seat_count=len(seats),
                    seat_titles=titles,
                )
            )
        return result

    def resolve_room_query(self, plan: "BookingPlan") -> str:
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

    def get_floors_for_booking(self, plan: "BookingPlan") -> list[dict[str, Any]]:
        """定位方案对应的楼层座位数据（抢座编排用，按预约开始时间查询）。"""
        return self._load_seat_map(
            self.resolve_room_query(plan),
            build_begin_time(plan.start_hour, plan.book_days),
            plan.duration_hours,
        )

    def find_seat(
        self, floors: list[dict[str, Any]], floor_id: str | int, seat_num: str | int
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """在楼层列表中定位指定楼层和座位号（逐字搬迁自 ``LibraryClient.find_seat_in_floors``）。"""
        floor_id = str(floor_id)
        seat_num = str(seat_num)
        floor_names: list[str] = []
        target_floor = None

        for item in floors:
            info = item.get("seatMap", {}).get("info", {})
            floor_names.append(f"{item.get('roomName', '?')}={info.get('id', '?')}")
            if str(info.get("id")) == floor_id:
                target_floor = item
                break

        if not target_floor:
            raise SeatQueryError(f"找不到楼层 id={floor_id}。可用楼层：{', '.join(floor_names)}")

        seats = target_floor["seatMap"]["POIs"]
        matches = [seat for seat in seats if str(seat.get("title")) == seat_num]
        if not matches:
            raise SeatQueryError(f"{target_floor.get('roomName')} 中找不到 {seat_num} 座")
        if len(matches) > 1:
            raise SeatQueryError(f"{target_floor.get('roomName')} 中存在多个 {seat_num} 座")
        return target_floor, matches[0]

    @staticmethod
    def resolve_room_type(name: str) -> int | None:
        """房间类型名 -> 编号（1=自习室 …）；无法识别返回 None。"""
        for num, label in ROOM_TYPE_MAP.items():
            if label in name:
                return int(num)
        return None
